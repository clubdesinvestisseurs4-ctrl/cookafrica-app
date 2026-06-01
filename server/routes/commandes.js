const express = require('express');
const { db } = require('../firebase-admin');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { pushNotification } = require('../utils/notifications');

const router = express.Router();

async function getNextNumero() {
  const snap = await db.collection('commandes').orderBy('createdAt', 'desc').limit(1).get();
  if (snap.empty) return 'CMD-0001';
  const last = snap.docs[0].data();
  const lastNum = parseInt((last.numero || 'CMD-0000').split('-')[1] || '0', 10);
  return `CMD-${String(lastNum + 1).padStart(4, '0')}`;
}

// GET /api/commandes
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { statut, date } = req.query;
    let query = db.collection('commandes').orderBy('createdAt', 'desc').limit(200);

    const snap = await query.get();
    let commandes = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (statut) commandes = commandes.filter(c => c.statut === statut);
    if (date)   commandes = commandes.filter(c => c.date === date);

    res.json(commandes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/commandes/bar — commandes avec boissons (pour le barman)
router.get('/bar', authenticateToken, requireRole('directeur', 'barman'), async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const snap = await db.collection('commandes').orderBy('createdAt', 'desc').limit(200).get();
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    const active = all
      .filter(c => c.boissonsStatut === 'en-attente')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const done = all.filter(c => c.date === today && c.boissonsStatut === 'prete');

    const barFacturesSnap = await db.collection('factures_bar').where('date', '==', today).get();
    const barFactures = {};
    barFacturesSnap.docs.forEach(d => {
      const data = d.data();
      barFactures[data.commandeId] = { id: d.id, ...data };
    });

    res.json({ active, done, barFactures });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/commandes/cuisine — commandes actives + terminées du jour (plats uniquement)
router.get('/cuisine', authenticateToken, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const [activeSnap, todaySnap] = await Promise.all([
      db.collection('commandes')
        .where('statut', 'in', ['en-attente', 'en-preparation'])
        .orderBy('createdAt', 'asc').get(),
      db.collection('commandes')
        .where('date', '==', today)
        .orderBy('createdAt', 'desc').get(),
    ]);

    // Exclure les boissons : la cuisine ne gère que les plats
    const active = activeSnap.docs
      .map(d => {
        const data = d.data();
        return { id: d.id, ...data, items: (data.items || []).filter(i => i.categorie !== 'Boissons') };
      })
      .filter(c => c.items.length > 0);

    const terminee = todaySnap.docs
      .map(d => {
        const data = d.data();
        return { id: d.id, ...data, items: (data.items || []).filter(i => i.categorie !== 'Boissons') };
      })
      .filter(c => ['prete', 'servie'].includes(c.statut) && c.items.length > 0);

    res.json({ active, terminee });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/commandes
router.post('/', authenticateToken, requireRole('directeur', 'receptionniste'), async (req, res) => {
  try {
    const { items, note, tableNumero } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'La commande doit contenir au moins un article' });
    }

    const total = items.reduce((sum, i) => sum + (Number(i.prix) * Number(i.quantite)), 0);
    const numero = await getNextNumero();
    const now = new Date();

    const mappedItems = items.map(i => ({
      menuItemId: i.menuItemId || '',
      nom: i.nom,
      prix: Number(i.prix),
      quantite: Number(i.quantite),
      sousTotal: Number(i.prix) * Number(i.quantite),
      categorie: i.categorie || '',
    }));

    const hasBoissons = mappedItems.some(i => i.categorie === 'Boissons');

    const data = {
      numero,
      items: mappedItems,
      total,
      note: note || '',
      tableNumero: tableNumero || '',
      statut: 'en-attente',
      date: now.toISOString().split('T')[0],
      createdBy: req.user.username,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    if (hasBoissons) data.boissonsStatut = 'en-attente';

    const ref = await db.collection('commandes').add(data);

    pushNotification({
      type: 'info', icon: 'utensils',
      titre: `Nouvelle commande ${numero}`,
      message: `${items.length} article(s) – Total: ${total.toLocaleString('fr-FR')} FCFA`,
      createdBy: req.user.username,
    });

    res.status(201).json({ id: ref.id, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/commandes/:id/bar-pret — barman marque les boissons comme prêtes
router.put('/:id/bar-pret', authenticateToken, requireRole('directeur', 'barman'), async (req, res) => {
  try {
    const docRef = db.collection('commandes').doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Commande introuvable' });

    const commande = doc.data();
    if (commande.boissonsStatut !== 'en-attente') {
      return res.status(400).json({ error: 'Boissons déjà traitées' });
    }

    const now = new Date();

    // Si la commande n'a que des boissons, la marquer comme prête côté plats aussi
    const allBoissons = (commande.items || []).every(i => i.categorie === 'Boissons');
    const commandeUpdate = { boissonsStatut: 'prete', updatedAt: now.toISOString() };
    if (allBoissons) commandeUpdate.statut = 'prete';
    await docRef.update(commandeUpdate);

    const boissonsItems = (commande.items || []).filter(i => i.categorie === 'Boissons');
    let factureBar = null;

    if (boissonsItems.length > 0) {
      const lastSnap = await db.collection('factures_bar').orderBy('createdAt', 'desc').limit(1).get();
      const lastNum = lastSnap.empty
        ? 0
        : parseInt((lastSnap.docs[0].data().numero || 'BAR-0000').split('-')[1] || '0', 10);
      const barNumero = `BAR-${String(lastNum + 1).padStart(4, '0')}`;

      const sousTotal = boissonsItems.reduce((sum, i) => sum + i.sousTotal, 0);
      const tva = Math.round(sousTotal * 0.18);
      const total = sousTotal + tva;

      const factureBarData = {
        numero: barNumero,
        commandeId: req.params.id,
        commandeNumero: commande.numero,
        items: boissonsItems,
        tableNumero: commande.tableNumero || '',
        note: commande.note || '',
        sousTotal,
        tva,
        total,
        reste: total,
        statut: 'partielle',
        modePaiement: 'especes',
        date: now.toISOString().split('T')[0],
        createdBy: req.user.username,
        createdAt: now.toISOString(),
      };

      const ref = await db.collection('factures_bar').add(factureBarData);
      factureBar = { id: ref.id, ...factureBarData };
    }

    pushNotification({
      type: 'success', icon: 'wine-glass-alt',
      titre: 'Boissons prêtes',
      message: `${commande.numero} – boissons prêtes à servir !`,
      createdBy: req.user.username,
    });

    res.json({ id: req.params.id, boissonsStatut: 'prete', factureBar });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/commandes/:id — mise à jour statut ou infos
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const docRef = db.collection('commandes').doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Commande introuvable' });

    const existing = doc.data();
    const now = new Date();
    const update = { ...req.body, updatedAt: now.toISOString() };
    delete update.id;

    await docRef.update(update);

    // Notifications selon changement de statut
    if (update.statut && update.statut !== existing.statut) {
      const messages = {
        'en-preparation': { type: 'info',    icon: 'fire',           titre: 'En préparation', msg: `${existing.numero} – démarré en cuisine` },
        'prete':          { type: 'success', icon: 'check-circle',   titre: 'Commande prête', msg: `${existing.numero} – prête à servir !` },
        'servie':         { type: 'success', icon: 'concierge-bell', titre: 'Commande servie', msg: `${existing.numero} – servie au client` },
        'annulee':        { type: 'danger',  icon: 'times-circle',   titre: 'Commande annulée', msg: `${existing.numero} – annulée` },
      };
      const notif = messages[update.statut];
      if (notif) pushNotification({ type: notif.type, icon: notif.icon, titre: notif.titre, message: notif.msg, createdBy: req.user.username });

      // Auto-générer la facture plats dès que la commande est prête
      if (update.statut === 'prete') {
        // Ne générer une facture plats que s'il y a au moins un article non-Boissons
        const platsItems = (existing.items || []).filter(i => i.categorie !== 'Boissons');
        if (platsItems.length > 0) {
          const alreadyExists = await db.collection('factures')
            .where('commandeId', '==', req.params.id).limit(1).get();

          if (alreadyExists.empty) {
            const lastSnap = await db.collection('factures').orderBy('createdAt', 'desc').limit(1).get();
            const lastNum = lastSnap.empty
              ? 0
              : parseInt((lastSnap.docs[0].data().numero || 'FACT-0000').split('-')[1] || '0', 10);
            const factureNumero = `FACT-${String(lastNum + 1).padStart(4, '0')}`;

            const TVA = 0.18;
            const sousTotal = platsItems.reduce((sum, i) => sum + i.sousTotal, 0);
            const tva       = Math.round(sousTotal * TVA);
            const total     = sousTotal + tva;

            await db.collection('factures').add({
              numero:          factureNumero,
              commandeId:      req.params.id,
              commandeNumero:  existing.numero,
              items:           platsItems,
              tableNumero:     existing.tableNumero || '',
              note:            existing.note || '',
              sousTotal,
              tva,
              total,
              reste:           total,
              modePaiement:    'especes',
              statut:          'partielle',
              date:            now.toISOString().split('T')[0],
              createdBy:       req.user.username,
              createdAt:       now.toISOString(),
            });

            pushNotification({
              type: 'success', icon: 'receipt',
              titre: `Facture ${factureNumero} générée`,
              message: `${existing.numero} – Total TTC : ${total.toLocaleString('fr-FR')} FCFA`,
              createdBy: req.user.username,
            });
          }
        }
      }
    }

    res.json({ id: req.params.id, ...existing, ...update });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/commandes/:id — annulation (directeur uniquement)
router.delete('/:id', authenticateToken, requireRole('directeur'), async (req, res) => {
  try {
    await db.collection('commandes').doc(req.params.id).update({
      statut: 'annulee',
      updatedAt: new Date().toISOString(),
    });
    res.json({ message: 'Commande annulée' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

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

// GET /api/commandes/cuisine — commandes actives + terminées du jour
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

    const active = activeSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const terminee = todaySnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(c => ['prete', 'servie'].includes(c.statut));

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

    const data = {
      numero,
      items: items.map(i => ({
        menuItemId: i.menuItemId || '',
        nom: i.nom,
        prix: Number(i.prix),
        quantite: Number(i.quantite),
        sousTotal: Number(i.prix) * Number(i.quantite),
      })),
      total,
      note: note || '',
      tableNumero: tableNumero || '',
      statut: 'en-attente',
      date: now.toISOString().split('T')[0],
      createdBy: req.user.username,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

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

      // Auto-générer la facture dès que la commande est prête
      if (update.statut === 'prete') {
        const alreadyExists = await db.collection('factures')
          .where('commandeId', '==', req.params.id).limit(1).get();

        if (alreadyExists.empty) {
          const lastSnap = await db.collection('factures').orderBy('createdAt', 'desc').limit(1).get();
          const lastNum = lastSnap.empty
            ? 0
            : parseInt((lastSnap.docs[0].data().numero || 'FACT-0000').split('-')[1] || '0', 10);
          const factureNumero = `FACT-${String(lastNum + 1).padStart(4, '0')}`;

          const TVA = 0.18;
          const sousTotal = existing.total || 0;
          const tva       = Math.round(sousTotal * TVA);
          const total     = sousTotal + tva;

          await db.collection('factures').add({
            numero:          factureNumero,
            commandeId:      req.params.id,
            commandeNumero:  existing.numero,
            items:           existing.items,
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

          // Déduire chaque article de la commande du stock journalier de plats
          const factureDate = now.toISOString().split('T')[0];
          for (const item of existing.items || []) {
            if (!item.menuItemId) continue;
            const snapPlat = await db.collection('stocks_plats')
              .where('menuItemId', '==', item.menuItemId)
              .where('date', '==', factureDate)
              .limit(1).get();
            if (!snapPlat.empty) {
              const platDoc  = snapPlat.docs[0];
              const restante = platDoc.data().quantiteRestante || 0;
              await platDoc.ref.update({
                quantiteRestante: Math.max(0, restante - (item.quantite || 1)),
                updatedAt: now.toISOString(),
              });
            }
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

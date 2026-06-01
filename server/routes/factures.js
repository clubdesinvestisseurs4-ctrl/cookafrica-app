const express = require('express');
const { db } = require('../firebase-admin');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { pushNotification } = require('../utils/notifications');

const router = express.Router();

const TVA_RATE = 0.18;

async function getNextNumeroFacture() {
  const snap = await db.collection('factures').orderBy('createdAt', 'desc').limit(1).get();
  if (snap.empty) return 'FACT-0001';
  const last = snap.docs[0].data();
  const lastNum = parseInt((last.numero || 'FACT-0000').split('-')[1] || '0', 10);
  return `FACT-${String(lastNum + 1).padStart(4, '0')}`;
}

// GET /api/factures
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { debut, fin, statut } = req.query;
    const snap = await db.collection('factures').orderBy('createdAt', 'desc').limit(300).get();
    let factures = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (debut)  factures = factures.filter(f => f.date >= debut);
    if (fin)    factures = factures.filter(f => f.date <= fin);
    if (statut) factures = factures.filter(f => f.statut === statut);

    res.json(factures);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/factures/bar — lister les bons bar
router.get('/bar', authenticateToken, async (req, res) => {
  try {
    const { debut, fin, statut } = req.query;
    const snap = await db.collection('factures_bar').orderBy('createdAt', 'desc').limit(300).get();
    let factures = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (debut)  factures = factures.filter(f => f.date >= debut);
    if (fin)    factures = factures.filter(f => f.date <= fin);
    if (statut) factures = factures.filter(f => f.statut === statut);
    res.json(factures);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/factures/:id
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const doc = await db.collection('factures').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Facture introuvable' });
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/factures — générer une facture depuis une commande
router.post('/', authenticateToken, requireRole('directeur', 'receptionniste'), async (req, res) => {
  try {
    const { commandeId, modePaiement } = req.body;
    if (!commandeId) return res.status(400).json({ error: 'commandeId requis' });

    const cmdDoc = await db.collection('commandes').doc(commandeId).get();
    if (!cmdDoc.exists) return res.status(404).json({ error: 'Commande introuvable' });

    const commande = cmdDoc.data();

    // Vérifier qu'une facture n'existe pas déjà pour cette commande
    const existing = await db.collection('factures').where('commandeId', '==', commandeId).limit(1).get();
    if (!existing.empty) return res.status(409).json({ error: 'Une facture existe déjà pour cette commande' });

    // Ne facturer que les plats (pas les boissons — gérées par le bon bar)
    const platsItems = (commande.items || []).filter(i => i.categorie !== 'Boissons');
    if (platsItems.length === 0) {
      return res.status(400).json({ error: 'Cette commande ne contient que des boissons, utilisez le bon bar' });
    }

    const sousTotal = platsItems.reduce((sum, i) => sum + i.sousTotal, 0);
    const tva = Math.round(sousTotal * TVA_RATE);
    const total = sousTotal + tva;

    const numero = await getNextNumeroFacture();
    const now = new Date();

    const data = {
      numero,
      commandeId,
      commandeNumero: commande.numero,
      items: platsItems,
      tableNumero: commande.tableNumero || '',
      note: commande.note || '',
      sousTotal,
      tva,
      total,
      reste: total,
      modePaiement: modePaiement || 'especes',
      statut: 'partielle',
      date: now.toISOString().split('T')[0],
      createdBy: req.user.username,
      createdAt: now.toISOString(),
    };

    const ref = await db.collection('factures').add(data);

    // Marquer la commande comme servie si pas encore fait
    if (!['servie', 'annulee'].includes(commande.statut)) {
      await db.collection('commandes').doc(commandeId).update({
        statut: 'servie',
        updatedAt: now.toISOString(),
      });
    }

    pushNotification({
      type: 'success', icon: 'receipt',
      titre: `Facture ${numero} générée`,
      message: `${commande.numero} – Total: ${total.toLocaleString('fr-FR')} FCFA – ${data.statut}`,
      createdBy: req.user.username,
    });

    res.status(201).json({ id: ref.id, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/factures/bar/:id/pay — payer un bon bar + déduire boissons du stock
router.put('/bar/:id/pay', authenticateToken, requireRole('directeur', 'receptionniste'), async (req, res) => {
  try {
    const { modePaiement } = req.body;
    const docRef = db.collection('factures_bar').doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Bon bar introuvable' });

    const facture = doc.data();
    if (facture.statut === 'payee') return res.status(400).json({ error: 'Déjà payé' });

    const now = new Date();
    const update = {
      statut: 'payee',
      reste: 0,
      modePaiement: modePaiement || facture.modePaiement || 'especes',
      updatedAt: now.toISOString(),
    };
    await docRef.update(update);

    // Déduire les boissons du stock journalier
    const factureDate = facture.date || now.toISOString().split('T')[0];
    for (const item of (facture.items || [])) {
      if (!item.menuItemId) continue;
      const snapPlat = await db.collection('stocks_plats')
        .where('menuItemId', '==', item.menuItemId)
        .where('date', '==', factureDate)
        .limit(1).get();
      if (!snapPlat.empty) {
        const platDoc = snapPlat.docs[0];
        const restante = platDoc.data().quantiteRestante || 0;
        await platDoc.ref.update({
          quantiteRestante: Math.max(0, restante - (item.quantite || 1)),
          updatedAt: now.toISOString(),
        });
      }
    }

    // Marquer la commande "servie" si la partie plats est aussi payée (ou absente)
    if (facture.commandeId) {
      const cmdDoc = await db.collection('commandes').doc(facture.commandeId).get();
      if (cmdDoc.exists && !['servie', 'annulee'].includes(cmdDoc.data().statut)) {
        const platsSnap = await db.collection('factures')
          .where('commandeId', '==', facture.commandeId).limit(1).get();
        const platsPaid = platsSnap.empty || platsSnap.docs[0].data().statut === 'payee';
        if (platsPaid) {
          await db.collection('commandes').doc(facture.commandeId).update({
            statut: 'servie',
            updatedAt: now.toISOString(),
          });
        }
      }
    }

    pushNotification({
      type: 'success', icon: 'money-bill-wave',
      titre: 'Paiement bar enregistré',
      message: `${facture.numero} – ${(facture.total || 0).toLocaleString('fr-FR')} FCFA encaissés`,
      createdBy: req.user.username,
    });

    res.json({ id: req.params.id, ...facture, ...update });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/factures/:id/pay — enregistrer paiement complet (plats)
router.put('/:id/pay', authenticateToken, requireRole('directeur', 'receptionniste'), async (req, res) => {
  try {
    const { modePaiement } = req.body;
    const docRef = db.collection('factures').doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Facture introuvable' });

    const facture = doc.data();
    const now = new Date();
    const update = {
      statut: 'payee',
      reste: 0,
      modePaiement: modePaiement || facture.modePaiement,
      updatedAt: now.toISOString(),
    };
    await docRef.update(update);

    // Déduire les plats du stock journalier (uniquement les non-Boissons)
    const factureDate = facture.date || now.toISOString().split('T')[0];
    for (const item of (facture.items || [])) {
      if (!item.menuItemId || item.categorie === 'Boissons') continue;
      const snapPlat = await db.collection('stocks_plats')
        .where('menuItemId', '==', item.menuItemId)
        .where('date', '==', factureDate)
        .limit(1).get();
      if (!snapPlat.empty) {
        const platDoc = snapPlat.docs[0];
        const restante = platDoc.data().quantiteRestante || 0;
        await platDoc.ref.update({
          quantiteRestante: Math.max(0, restante - (item.quantite || 1)),
          updatedAt: now.toISOString(),
        });
      }
    }

    // Marquer la commande "servie" si la partie bar est aussi payée (ou absente)
    if (facture.commandeId) {
      const cmdDoc = await db.collection('commandes').doc(facture.commandeId).get();
      if (cmdDoc.exists && !['servie', 'annulee'].includes(cmdDoc.data().statut)) {
        const barSnap = await db.collection('factures_bar')
          .where('commandeId', '==', facture.commandeId).limit(1).get();
        const barPaid = barSnap.empty || barSnap.docs[0].data().statut === 'payee';
        if (barPaid) {
          await db.collection('commandes').doc(facture.commandeId).update({
            statut: 'servie',
            updatedAt: now.toISOString(),
          });
        }
      }
    }

    pushNotification({
      type: 'success', icon: 'money-bill-wave',
      titre: 'Paiement enregistré',
      message: `${facture.numero} – ${facture.total.toLocaleString('fr-FR')} FCFA encaissés`,
      createdBy: req.user.username,
    });

    res.json({ id: req.params.id, ...facture, ...update });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

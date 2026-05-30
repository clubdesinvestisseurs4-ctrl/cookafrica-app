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
    const { commandeId, modePaiement, acompte } = req.body;
    if (!commandeId) return res.status(400).json({ error: 'commandeId requis' });

    const cmdDoc = await db.collection('commandes').doc(commandeId).get();
    if (!cmdDoc.exists) return res.status(404).json({ error: 'Commande introuvable' });

    const commande = cmdDoc.data();

    // Vérifier qu'une facture n'existe pas déjà pour cette commande
    const existing = await db.collection('factures').where('commandeId', '==', commandeId).limit(1).get();
    if (!existing.empty) return res.status(409).json({ error: 'Une facture existe déjà pour cette commande' });

    const sousTotal = commande.total || 0;
    const tva = Math.round(sousTotal * TVA_RATE);
    const total = sousTotal + tva;
    const acompteVal = Number(acompte) || 0;
    const reste = total - acompteVal;

    const numero = await getNextNumeroFacture();
    const now = new Date();

    const data = {
      numero,
      commandeId,
      commandeNumero: commande.numero,
      items: commande.items,
      tableNumero: commande.tableNumero || '',
      note: commande.note || '',
      sousTotal,
      tva,
      total,
      acompte: acompteVal,
      reste: Math.max(0, reste),
      modePaiement: modePaiement || 'especes',
      statut: reste <= 0 ? 'payee' : 'partielle',
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

// PUT /api/factures/:id/pay — enregistrer paiement complet
router.put('/:id/pay', authenticateToken, requireRole('directeur', 'receptionniste'), async (req, res) => {
  try {
    const { modePaiement } = req.body;
    const docRef = db.collection('factures').doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Facture introuvable' });

    const facture = doc.data();
    const update = {
      statut: 'payee',
      reste: 0,
      acompte: facture.total,
      modePaiement: modePaiement || facture.modePaiement,
      updatedAt: new Date().toISOString(),
    };
    await docRef.update(update);

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

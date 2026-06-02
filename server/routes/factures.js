const express = require('express');
const { db } = require('../firebase-admin');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { pushNotification } = require('../utils/notifications');
const cache = require('../utils/cache');

const router = express.Router();

function invalidate() {
  cache.del('factures:list', 'commandes:bar', 'commandes:cuisine');
}

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

    let all = cache.get('factures:list');
    if (!all) {
      const snap = await db.collection('factures').orderBy('createdAt', 'desc').limit(300).get();
      all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      cache.set('factures:list', all, 60_000);
    }

    let factures = all;
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
    // Chercher d'abord dans le cache liste avant de faire un appel BD
    const cached = cache.get('factures:list');
    if (cached) {
      const found = cached.find(f => f.id === req.params.id);
      if (found) return res.json(found);
    }
    const doc = await db.collection('factures').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Facture introuvable' });
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/factures — générer manuellement une facture unifiée depuis une commande
router.post('/', authenticateToken, requireRole('directeur', 'receptionniste'), async (req, res) => {
  try {
    const { commandeId, modePaiement } = req.body;
    if (!commandeId) return res.status(400).json({ error: 'commandeId requis' });

    const cmdDoc = await db.collection('commandes').doc(commandeId).get();
    if (!cmdDoc.exists) return res.status(404).json({ error: 'Commande introuvable' });

    const commande = cmdDoc.data();

    // Vérifier qu'une facture n'existe pas déjà
    const existing = await db.collection('factures').where('commandeId', '==', commandeId).limit(1).get();
    if (!existing.empty) return res.status(409).json({ error: 'Une facture existe déjà pour cette commande' });

    // Vérifier que toutes les parties sont prêtes
    const hasBoissons = (commande.items || []).some(i => i.categorie === 'Boissons');
    const hasPlats    = (commande.items || []).some(i => i.categorie !== 'Boissons');

    if (hasPlats && !['prete', 'servie'].includes(commande.statut)) {
      return res.status(400).json({ error: 'Les plats ne sont pas encore prêts (la cuisine n\'a pas validé)' });
    }
    if (hasBoissons && commande.boissonsStatut !== 'prete') {
      return res.status(400).json({ error: 'Les boissons ne sont pas encore prêtes (le barman n\'a pas validé)' });
    }

    const allItems = commande.items || [];
    if (allItems.length === 0) return res.status(400).json({ error: 'La commande est vide' });

    const total = allItems.reduce((sum, i) => sum + i.sousTotal, 0);
    const numero = await getNextNumeroFacture();
    const now = new Date();

    const data = {
      numero,
      commandeId,
      commandeNumero: commande.numero,
      items: allItems,
      tableNumero: commande.tableNumero || '',
      note: commande.note || '',
      total,
      reste: total,
      modePaiement: modePaiement || 'especes',
      statut: 'partielle',
      validatedByCuisinier: commande.validatedByCuisinier || '',
      validatedByCuisinierNom: commande.validatedByCuisinierNom || '',
      validatedByBarman: commande.validatedByBarman || '',
      validatedByBarmanNom: commande.validatedByBarmanNom || '',
      date: now.toISOString().split('T')[0],
      createdBy: req.user.username,
      createdAt: now.toISOString(),
    };

    const ref = await db.collection('factures').add(data);
    invalidate();

    pushNotification({
      type: 'success', icon: 'receipt',
      titre: `Facture ${numero} générée`,
      message: `${commande.numero} – Total: ${total.toLocaleString('fr-FR')} FCFA`,
      createdBy: req.user.username,
    });

    res.status(201).json({ id: ref.id, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/factures/:id/pay — enregistrer le paiement de la facture unifiée
router.put('/:id/pay', authenticateToken, requireRole('directeur', 'receptionniste'), async (req, res) => {
  try {
    const { modePaiement } = req.body;
    const docRef = db.collection('factures').doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Facture introuvable' });

    const facture = doc.data();
    if (facture.statut === 'payee') return res.status(400).json({ error: 'Facture déjà payée' });

    const now = new Date();
    const update = {
      statut: 'payee',
      reste: 0,
      modePaiement: modePaiement || facture.modePaiement,
      updatedAt: now.toISOString(),
    };
    await docRef.update(update);
    invalidate();
    cache.del('commandes:list'); // la commande passera à 'servie'

    // Déduire tous les articles (plats + boissons) du stock journalier
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

    // Marquer la commande comme servie
    if (facture.commandeId) {
      const cmdDoc = await db.collection('commandes').doc(facture.commandeId).get();
      if (cmdDoc.exists && !['servie', 'annulee'].includes(cmdDoc.data().statut)) {
        await db.collection('commandes').doc(facture.commandeId).update({
          statut: 'servie',
          updatedAt: now.toISOString(),
        });
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

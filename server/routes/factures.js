const express = require('express');
const { db } = require('../firebase-admin');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { pushNotification } = require('../utils/notifications');
const cache    = require('../utils/cache');
const eventBus = require('../utils/eventBus');
const { createFactureFromCommande } = require('../utils/factures');

const router = express.Router();

function invalidate() {
  cache.del('factures:list', 'commandes:list', 'stats:dashboard', 'stats:notifications');
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

    let factures = all.filter(f => !f.type || f.type === 'facture');
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

// POST /api/factures/repair-numeros — corrige les numéros invalides (FACT-0NaN) en base
router.post('/repair-numeros', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const allSnap = await db.collection('factures').orderBy('createdAt', 'asc').get();

    let maxNum = 0;
    const broken = [];

    allSnap.docs.forEach(doc => {
      const data = doc.data();
      // Ignorer les bons cuisine/bar — ils ont leurs propres formats
      if (data.type && data.type !== 'facture') return;
      const numero = data.numero || '';
      if (!numero.startsWith('FACT-')) return;
      const n = parseInt(numero.slice(5), 10);
      if (!isNaN(n)) {
        if (n > maxNum) maxNum = n;
      } else {
        broken.push({ id: doc.id, oldNumero: numero });
      }
    });

    if (broken.length === 0) {
      return res.json({ message: 'Aucune facture à réparer.', details: [] });
    }

    const batch = db.batch();
    const details = [];
    for (const item of broken) {
      maxNum++;
      const newNumero = `FACT-${String(maxNum).padStart(4, '0')}`;
      batch.update(db.collection('factures').doc(item.id), { numero: newNumero });
      details.push({ id: item.id, ancien: item.oldNumero, nouveau: newNumero });
    }
    await batch.commit();
    invalidate();

    res.json({ message: `${broken.length} facture(s) réparée(s)`, details });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/factures — générer manuellement une facture depuis une commande
router.post('/', authenticateToken, requireRole('admin', 'caissiere', 'caissier-en-ligne'), async (req, res) => {
  try {
    const { commandeId, modePaiement } = req.body;
    if (!commandeId) return res.status(400).json({ error: 'commandeId requis' });

    const cmdDoc = await db.collection('commandes').doc(commandeId).get();
    if (!cmdDoc.exists) return res.status(404).json({ error: 'Commande introuvable' });

    const commande = cmdDoc.data();
    if (commande.statut !== 'en-preparation') {
      return res.status(400).json({ error: 'La commande doit d\'abord être envoyée à la facturation' });
    }

    const result = await createFactureFromCommande(db, commande, commandeId, {
      modePaiement,
      createdBy: req.user.username,
      caissiereName: req.user.nom || req.user.username || '',
    });
    if (result.error) return res.status(409).json({ error: result.error });
    const { facture } = result;

    invalidate();
    eventBus.emit('factures');
    eventBus.emit('commandes');

    pushNotification({
      type: 'success', icon: 'receipt',
      titre: `Facture ${facture.numero} générée`,
      message: `${commande.numero} – Total: ${facture.total.toLocaleString('fr-FR')} FCFA`,
      createdBy: req.user.username,
    });

    res.status(201).json(facture);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/factures/:id/pay — enregistrer le paiement
// La caissière (ou l'admin) peut ajuster librement le prix de chaque article,
// à la hausse comme à la baisse, sans autorisation particulière.
router.put('/:id/pay', authenticateToken, requireRole('admin', 'caissiere', 'caissier-en-ligne'), async (req, res) => {
  try {
    const { modePaiement, items } = req.body;
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
      caissiereName: req.user.nom || req.user.username || '',
      updatedAt: now.toISOString(),
    };

    let finalItems = facture.items || [];

    if (Array.isArray(items) && items.length > 0) {
      const mappedItems = items.map(i => ({
        menuItemId: i.menuItemId || '',
        nom: i.nom,
        prix: Number(i.prix),
        quantite: Number(i.quantite),
        sousTotal: Number(i.prix) * Number(i.quantite),
        categorie: i.categorie || '',
      }));

      finalItems = mappedItems;
      update.items = mappedItems;
      update.total = mappedItems.reduce((s, i) => s + i.sousTotal, 0);
    }

    await docRef.update(update);
    invalidate();
    cache.del('commandes:list');
    eventBus.emit('factures');
    eventBus.emit('commandes');
    eventBus.emit('stocks');

    // Déduire les articles du stock journalier
    const factureDate = facture.date || now.toISOString().split('T')[0];
    for (const item of finalItems) {
      if (!item.menuItemId) continue;
      const stockRef = db.collection('stocks_plats').doc(`${item.menuItemId}_${factureDate}`);
      const platDoc = await stockRef.get();
      if (platDoc.exists) {
        const restante = platDoc.data().quantiteRestante || 0;
        await stockRef.update({
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

    const finalTotal = update.total ?? facture.total;
    pushNotification({
      type: 'success', icon: 'money-bill-wave',
      titre: 'Paiement enregistré',
      message: `${facture.numero} – ${finalTotal.toLocaleString('fr-FR')} FCFA encaissés`,
      createdBy: req.user.username,
    });

    res.json({ id: req.params.id, ...facture, ...update, items: finalItems, total: finalTotal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/factures/:id/edit-items — caissière (ou admin) : modifie librement les articles
// d'une facture non encore payée (prix, quantités, ajout/suppression), sans autorisation requise.
router.post('/:id/edit-items', authenticateToken, requireRole('admin', 'caissiere', 'caissier-en-ligne'), async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'La facture doit contenir au moins un article' });
    }

    const docRef = db.collection('factures').doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Facture introuvable' });

    const facture = doc.data();
    if (facture.statut === 'payee') {
      return res.status(400).json({ error: 'Facture déjà payée, modification impossible' });
    }

    const mappedItems = items.map(i => ({
      menuItemId: i.menuItemId || '',
      nom: i.nom,
      prix: Number(i.prix),
      quantite: Number(i.quantite),
      sousTotal: Number(i.prix) * Number(i.quantite),
      categorie: i.categorie || '',
    }));
    const total = mappedItems.reduce((s, i) => s + i.sousTotal, 0);
    const now = new Date();

    const update = {
      items: mappedItems,
      total,
      reste: total, // rien n'a encore été payé sur une facture 'partielle'
      updatedAt: now.toISOString(),
      lastEditedBy: req.user.username,
      lastEditedByNom: req.user.nom || req.user.username,
      lastEditedAt: now.toISOString(),
    };

    await docRef.update(update);
    invalidate();
    eventBus.emit('factures');

    pushNotification({
      type: 'info', icon: 'edit',
      titre: 'Facture modifiée',
      message: `${facture.numero} — nouveau total : ${total.toLocaleString('fr-FR')} FCFA`,
      createdBy: req.user.username,
    });

    res.json({ id: req.params.id, ...facture, ...update });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

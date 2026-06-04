const express = require('express');
const { db } = require('../firebase-admin');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { pushNotification } = require('../utils/notifications');
const cache    = require('../utils/cache');
const eventBus = require('../utils/eventBus');

const router = express.Router();

function invalidate() {
  cache.del('factures:list', 'commandes:bar', 'commandes:cuisine');
}

async function getNextNumeroFacture() {
  // Scan les 200 derniers documents et trouve le numéro FACT le plus élevé.
  // Évite le bug où un bon cuisine/bar (CUI-CMD-0001, BAR-CMD-0001) est le
  // document le plus récent, ce qui faisait parseInt("CMD", 10) → NaN → "FACT-0NaN".
  const snap = await db.collection('factures').orderBy('createdAt', 'desc').limit(200).get();
  let maxNum = 0;
  snap.docs.forEach(doc => {
    const { numero } = doc.data();
    if (!numero || !numero.startsWith('FACT-')) return;
    const n = parseInt(numero.slice(5), 10); // slice(5) = après "FACT-"
    if (!isNaN(n) && n > maxNum) maxNum = n;
  });
  return `FACT-${String(maxNum + 1).padStart(4, '0')}`;
}

// GET /api/factures
// ?type=facture (défaut) → factures de paiement uniquement
// ?type=cuisine          → bons cuisine uniquement
// ?type=bar              → bons bar uniquement
// ?type=all              → tout (paiement + bons internes)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { debut, fin, statut, type } = req.query;

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

    // Filtre par type : par défaut n'affiche que les factures de paiement
    if (type === 'all')          { /* pas de filtre */ }
    else if (type === 'cuisine') { factures = factures.filter(f => f.type === 'cuisine'); }
    else if (type === 'bar')     { factures = factures.filter(f => f.type === 'bar'); }
    else                         { factures = factures.filter(f => !f.type || f.type === 'facture'); }

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
router.post('/', authenticateToken, requireRole('admin', 'caissiere'), async (req, res) => {
  try {
    const { commandeId, modePaiement } = req.body;
    if (!commandeId) return res.status(400).json({ error: 'commandeId requis' });

    const cmdDoc = await db.collection('commandes').doc(commandeId).get();
    if (!cmdDoc.exists) return res.status(404).json({ error: 'Commande introuvable' });

    const commande = cmdDoc.data();

    const existing = await db.collection('factures').where('commandeId', '==', commandeId).limit(1).get();
    if (!existing.empty) return res.status(409).json({ error: 'Une facture existe déjà pour cette commande' });

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
      type: 'facture',
      commandeId,
      commandeNumero: commande.numero,
      items: allItems,
      tableNumero: commande.tableNumero || '',
      note: commande.note || '',
      total,
      reste: total,
      modePaiement: modePaiement || 'especes',
      statut: 'partielle',
      serveurNom: commande.createdByNom || commande.createdBy || '',
      caissiereName: req.user.nom || req.user.username || '',
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
    eventBus.emit('factures');
    eventBus.emit('commandes');

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

// PUT /api/factures/:id/pay — enregistrer le paiement
router.put('/:id/pay', authenticateToken, requireRole('admin', 'caissiere'), async (req, res) => {
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
      caissiereName: req.user.nom || req.user.username || '',
      updatedAt: now.toISOString(),
    };
    await docRef.update(update);
    invalidate();
    cache.del('commandes:list');
    eventBus.emit('factures');
    eventBus.emit('commandes');
    eventBus.emit('stocks');

    // Déduire les articles du stock journalier
    const factureDate = facture.date || now.toISOString().split('T')[0];
    for (const item of (facture.items || [])) {
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

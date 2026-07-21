const express = require('express');
const { db, admin } = require('../firebase-admin');
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
    // Le buffet est en libre-service : il n'attend pas la validation cuisine.
    const hasPlats    = (commande.items || []).some(i => i.categorie !== 'Boissons' && i.categorie !== 'Buffet');

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
// Autorise une modification de prix par article au moment du paiement :
// - hausse par rapport au prix standard du menu : libre.
// - baisse sous le prix standard : nécessite le code de dérogation admin (editGrant).
router.put('/:id/pay', authenticateToken, requireRole('admin', 'caissiere'), async (req, res) => {
  try {
    const { modePaiement, items, discountCode } = req.body;
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
    let consumedGrant = false;

    if (Array.isArray(items) && items.length > 0) {
      const menuSnap = await db.collection('menu').get();
      const menuById = {};
      menuSnap.docs.forEach(d => { menuById[d.id] = d.data(); });

      const mappedItems = items.map(i => ({
        menuItemId: i.menuItemId || '',
        nom: i.nom,
        prix: Number(i.prix),
        quantite: Number(i.quantite),
        sousTotal: Number(i.prix) * Number(i.quantite),
        categorie: i.categorie || '',
      }));

      const belowStandard = mappedItems.some(i => {
        const standard = menuById[i.menuItemId]?.prix ?? i.prix;
        return i.prix < standard;
      });

      if (belowStandard) {
        const grant = facture.editGrant;
        if (!grant || !grant.code) {
          return res.status(403).json({ error: 'Baisse sous le prix standard : demandez un code de dérogation à l\'admin' });
        }
        if (grant.code !== String(discountCode || '').trim()) {
          return res.status(403).json({ error: 'Code de dérogation incorrect' });
        }
        if (new Date(grant.expiresAt).getTime() < Date.now()) {
          return res.status(403).json({ error: 'Code de dérogation expiré' });
        }
        consumedGrant = true;
      }

      finalItems = mappedItems;
      update.items = mappedItems;
      update.total = mappedItems.reduce((s, i) => s + i.sousTotal, 0);
    }

    if (consumedGrant) update.editGrant = admin.firestore.FieldValue.delete();

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

    res.json({ id: req.params.id, ...facture, ...update, items: finalItems, total: finalTotal, editGrant: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/factures/:id/edit-grant/verify — vérifie un code sans muter la facture
// (permet de déverrouiller l'éditeur côté caissière avant de composer les modifications)
router.post('/:id/edit-grant/verify', authenticateToken, requireRole('admin', 'caissiere'), async (req, res) => {
  try {
    const { code } = req.body;
    const doc = await db.collection('factures').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Facture introuvable' });

    const facture = doc.data();
    const grant = facture.editGrant;
    if (!grant || !grant.code) return res.status(403).json({ error: 'Aucune autorisation de modification en cours pour cette facture' });
    if (grant.code !== String(code || '').trim()) return res.status(403).json({ error: 'Code incorrect' });
    if (new Date(grant.expiresAt).getTime() < Date.now()) return res.status(403).json({ error: 'Code expiré — redemandez une autorisation à l\'admin' });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/factures/:id/edit-grant — admin : autorise la caissière à modifier une facture
// pendant une durée limitée, via un code court communiqué de vive voix.
router.post('/:id/edit-grant', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const minutes = Number(req.body?.minutes);
    if (!minutes || minutes <= 0 || minutes > 120) {
      return res.status(400).json({ error: 'Durée invalide (1 à 120 minutes)' });
    }

    const docRef = db.collection('factures').doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Facture introuvable' });

    const facture = doc.data();
    if (facture.type && facture.type !== 'facture') {
      return res.status(400).json({ error: 'Seules les factures de paiement sont modifiables' });
    }
    if (facture.statut === 'payee') {
      return res.status(400).json({ error: 'Facture déjà payée, modification impossible' });
    }

    const now = new Date();
    const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 chiffres
    const expiresAt = new Date(now.getTime() + minutes * 60_000).toISOString();

    const editGrant = {
      code,
      expiresAt,
      grantedBy: req.user.username,
      grantedByNom: req.user.nom || req.user.username,
      grantedAt: now.toISOString(),
    };

    await docRef.update({ editGrant, updatedAt: now.toISOString() });
    invalidate();

    pushNotification({
      type: 'info', icon: 'key',
      titre: 'Code de modification généré',
      message: `Facture ${facture.numero} — modifiable pendant ${minutes} min`,
      createdBy: req.user.username,
    });

    // Le code n'est renvoyé qu'ici, une seule fois — à l'admin de le communiquer à la caissière.
    res.json({ code, expiresAt, numero: facture.numero });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/factures/:id/edit-items — caissière (ou admin) : applique la modification
// des articles d'une facture, en validant le code temporaire généré par l'admin.
router.post('/:id/edit-items', authenticateToken, requireRole('admin', 'caissiere'), async (req, res) => {
  try {
    const { code, items } = req.body;
    if (!code) return res.status(400).json({ error: 'Code requis' });
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

    const grant = facture.editGrant;
    if (!grant || !grant.code) {
      return res.status(403).json({ error: 'Aucune autorisation de modification en cours pour cette facture' });
    }
    if (grant.code !== String(code).trim()) {
      return res.status(403).json({ error: 'Code incorrect' });
    }
    if (new Date(grant.expiresAt).getTime() < Date.now()) {
      return res.status(403).json({ error: 'Code expiré — redemandez une autorisation à l\'admin' });
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
      editGrant: null, // code à usage unique
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

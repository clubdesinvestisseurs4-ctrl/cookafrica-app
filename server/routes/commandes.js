const express = require('express');
const { db } = require('../firebase-admin');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { pushNotification } = require('../utils/notifications');
const cache    = require('../utils/cache');
const eventBus = require('../utils/eventBus');

const router = express.Router();

// Invalide tous les caches commandes + factures (à appeler après chaque écriture)
function invalidate() {
  cache.del('commandes:list', 'commandes:cuisine', 'commandes:bar', 'factures:list');
}

async function getNextNumero() {
  const snap = await db.collection('commandes').orderBy('createdAt', 'desc').limit(1).get();
  if (snap.empty) return 'CMD-0001';
  const last = snap.docs[0].data();
  const lastNum = parseInt((last.numero || 'CMD-0000').split('-')[1] || '0', 10);
  return `CMD-${String(lastNum + 1).padStart(4, '0')}`;
}

async function getNextNumeroFacture() {
  // Scan 200 docs pour trouver le plus grand FACT-XXXX, en ignorant les bons CUI-/BAR-
  // (limit(1) causait parseInt("CMD",10)→NaN→"FACT-0NaN" quand le dernier doc était un bon interne)
  const snap = await db.collection('factures').orderBy('createdAt', 'desc').limit(200).get();
  let maxNum = 0;
  snap.docs.forEach(doc => {
    const { numero } = doc.data();
    if (!numero || !numero.startsWith('FACT-')) return;
    const n = parseInt(numero.slice(5), 10);
    if (!isNaN(n) && n > maxNum) maxNum = n;
  });
  return `FACT-${String(maxNum + 1).padStart(4, '0')}`;
}

// Bon interne cuisine — créé dès que la cuisinière valide (plats uniquement)
async function generateCuisineSubInvoice(commandeId, commande, validatedByCuisinier, now) {
  const docRef = db.collection('factures').doc(`cui_${commandeId}`);
  if ((await docRef.get()).exists) return null; // déjà créé

  const platsItems = (commande.items || []).filter(i => i.categorie !== 'Boissons');
  if (platsItems.length === 0) return null;

  const data = {
    numero: `CUI-${commande.numero}`,
    type: 'cuisine',
    commandeId,
    commandeNumero: commande.numero,
    items: platsItems,
    tableNumero: commande.tableNumero || '',
    note: commande.note || '',
    total: platsItems.reduce((s, i) => s + i.sousTotal, 0),
    validatedByCuisinier: validatedByCuisinier || '',
    validatedByCuisinierNom: commande.validatedByCuisinierNom || '',
    serveurNom: commande.createdByNom || commande.createdBy || '',
    date: now.toISOString().split('T')[0],
    createdBy: validatedByCuisinier || '',
    createdAt: now.toISOString(),
  };

  await docRef.set(data);
  cache.del('factures:list');
  return { id: `cui_${commandeId}`, ...data };
}

// Bon interne bar — créé dès que le barman valide (boissons uniquement)
async function generateBarSubInvoice(commandeId, commande, validatedByBarman, now) {
  const docRef = db.collection('factures').doc(`bar_${commandeId}`);
  if ((await docRef.get()).exists) return null; // déjà créé

  const boissonsItems = (commande.items || []).filter(i => i.categorie === 'Boissons');
  if (boissonsItems.length === 0) return null;

  const data = {
    numero: `BAR-${commande.numero}`,
    type: 'bar',
    commandeId,
    commandeNumero: commande.numero,
    items: boissonsItems,
    tableNumero: commande.tableNumero || '',
    total: boissonsItems.reduce((s, i) => s + i.sousTotal, 0),
    validatedByBarman: validatedByBarman || '',
    validatedByBarmanNom: commande.validatedByBarmanNom || '',
    serveurNom: commande.createdByNom || commande.createdBy || '',
    date: now.toISOString().split('T')[0],
    createdBy: validatedByBarman || '',
    createdAt: now.toISOString(),
  };

  await docRef.set(data);
  cache.del('factures:list', 'commandes:bar');
  return { id: `bar_${commandeId}`, ...data };
}

// Génère la facture unifiée (paiement) dès que les deux parties sont prêtes
async function generateCombinedInvoice(commandeId, commande, validatedByCuisinier, validatedByBarman, now) {
  // Vérifier uniquement les factures de paiement (pas les bons internes cuisine/bar)
  const existingSnap = await db.collection('factures').where('commandeId', '==', commandeId).get();
  const hasPaymentFact = existingSnap.docs.some(d => {
    const t = d.data().type;
    return !t || t === 'facture';
  });
  if (hasPaymentFact) return null;

  const allItems = commande.items || [];
  if (allItems.length === 0) return null;

  const total = allItems.reduce((sum, i) => sum + i.sousTotal, 0);
  const numero = await getNextNumeroFacture();

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
    modePaiement: 'especes',
    statut: 'partielle',
    serveurNom: commande.createdByNom || commande.createdBy || '',
    validatedByCuisinier: validatedByCuisinier || '',
    validatedByCuisinierNom: commande.validatedByCuisinierNom || '',
    validatedByBarman: validatedByBarman || '',
    validatedByBarmanNom: commande.validatedByBarmanNom || '',
    date: now.toISOString().split('T')[0],
    createdBy: commande.createdBy || '',
    createdAt: now.toISOString(),
  };

  const ref = await db.collection('factures').add(data);
  cache.del('factures:list', 'commandes:bar');

  pushNotification({
    type: 'success', icon: 'receipt',
    titre: `Facture ${numero} prête`,
    message: `${commande.numero} – Total : ${total.toLocaleString('fr-FR')} FCFA`,
    createdBy: validatedByCuisinier || validatedByBarman || 'système',
  });

  return { id: ref.id, ...data };
}

// GET /api/commandes
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { statut, date } = req.query;

    let all = cache.get('commandes:list');
    if (!all) {
      const snap = await db.collection('commandes').orderBy('createdAt', 'desc').limit(200).get();
      all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      cache.set('commandes:list', all, 15_000);
    }

    let result = all;
    if (statut) result = result.filter(c => c.statut === statut);
    if (date)   result = result.filter(c => c.date === date);

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/commandes/bar — commandes avec boissons (pour le barman)
router.get('/bar', authenticateToken, requireRole('admin', 'barman'), async (req, res) => {
  try {
    const cached = cache.get('commandes:bar');
    if (cached) return res.json(cached);

    const today = new Date().toISOString().split('T')[0];

    const [activeSnap, todaySnap, facturesSnap] = await Promise.all([
      db.collection('commandes').where('boissonsStatut', '==', 'en-attente').get(),
      db.collection('commandes').where('date', '==', today).orderBy('createdAt', 'desc').get(),
      db.collection('factures').where('date', '==', today).get(),
    ]);

    const active = activeSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(c => c.statut !== 'annulee')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const done = todaySnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(c => c.boissonsStatut === 'prete');

    const facturesMap = {};
    facturesSnap.docs.forEach(d => {
      const f = { id: d.id, ...d.data() };
      if (f.commandeId) facturesMap[f.commandeId] = f;
    });

    const result = { active, done, facturesMap };
    cache.set('commandes:bar', result, 15_000);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/commandes/cuisine — commandes actives + terminées du jour (plats uniquement)
router.get('/cuisine', authenticateToken, async (req, res) => {
  try {
    const cached = cache.get('commandes:cuisine');
    if (cached) return res.json(cached);

    const today = new Date().toISOString().split('T')[0];

    const [activeSnap, todaySnap] = await Promise.all([
      db.collection('commandes')
        .where('statut', 'in', ['en-attente', 'en-preparation'])
        .orderBy('createdAt', 'asc').get(),
      db.collection('commandes')
        .where('date', '==', today)
        .orderBy('createdAt', 'desc').get(),
    ]);

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

    const result = { active, terminee };
    cache.set('commandes:cuisine', result, 15_000);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/commandes
router.post('/', authenticateToken, requireRole('admin', 'serveur'), async (req, res) => {
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
      createdByNom: req.user.nom || req.user.username,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    if (hasBoissons) data.boissonsStatut = 'en-attente';

    const ref = await db.collection('commandes').add(data);
    invalidate();
    eventBus.emit('commandes');

    // Décrémenter quantiteRestante dans stocks_plats pour chaque article commandé
    const today = now.toISOString().split('T')[0];
    const epuises = [];
    for (const item of mappedItems) {
      if (!item.menuItemId) continue;
      const stockRef = db.collection('stocks_plats').doc(`${item.menuItemId}_${today}`);
      const stockDoc = await stockRef.get();
      if (stockDoc.exists) {
        const newRestante = Math.max(0, stockDoc.data().quantiteRestante - item.quantite);
        await stockRef.update({ quantiteRestante: newRestante, updatedAt: now.toISOString() });
        if (newRestante === 0) epuises.push(item.nom);
      }
    }

    pushNotification({
      type: 'info', icon: 'utensils',
      titre: `Nouvelle commande ${numero}`,
      message: `${items.length} article(s) – Total: ${total.toLocaleString('fr-FR')} FCFA`,
      createdBy: req.user.username,
    });

    if (epuises.length > 0) {
      pushNotification({
        type: 'danger', icon: 'exclamation-circle',
        titre: '⚠️ Stock épuisé',
        message: `Plus de stock : ${epuises.join(', ')}`,
        createdBy: req.user.username,
      });
    }

    res.status(201).json({ id: ref.id, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/commandes/:id/bar-pret — barman marque les boissons comme prêtes
router.put('/:id/bar-pret', authenticateToken, requireRole('admin', 'barman'), async (req, res) => {
  try {
    const docRef = db.collection('commandes').doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Commande introuvable' });

    const commande = doc.data();
    if (commande.boissonsStatut !== 'en-attente') {
      return res.status(400).json({ error: 'Boissons déjà traitées' });
    }

    const now = new Date();
    const allBoissons = (commande.items || []).every(i => i.categorie === 'Boissons');

    const commandeUpdate = {
      boissonsStatut: 'prete',
      validatedByBarman: req.user.username,
      validatedByBarmanNom: req.user.nom,
      updatedAt: now.toISOString(),
    };
    if (allBoissons) commandeUpdate.statut = 'prete';
    await docRef.update(commandeUpdate);
    invalidate();
    eventBus.emit('commandes');

    const updatedCommande = { ...commande, ...commandeUpdate };
    const platsItems = (commande.items || []).filter(i => i.categorie !== 'Boissons');
    const platsReady = platsItems.length === 0 || commande.statut === 'prete';

    // Bon interne bar (stocké en BD dès la validation barman)
    await generateBarSubInvoice(req.params.id, updatedCommande, req.user.username, now);

    // Facture de paiement unifiée (seulement si la cuisine est déjà prête aussi)
    let factureUnifiee = null;
    if (platsReady) {
      factureUnifiee = await generateCombinedInvoice(
        req.params.id,
        updatedCommande,
        commande.validatedByCuisinier || '',
        req.user.username,
        now
      );
    }

    pushNotification({
      type: 'success', icon: 'wine-glass-alt',
      titre: 'Boissons prêtes',
      message: `${commande.numero} – boissons prêtes à servir !${factureUnifiee ? ` Facture ${factureUnifiee.numero} générée.` : ''}`,
      createdBy: req.user.username,
    });

    res.json({ id: req.params.id, boissonsStatut: 'prete', factureUnifiee });
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

    // Whitelist : seuls le statut et les infos de service sont modifiables ici.
    // Empêche un utilisateur (ex. cuisinière, barman) de modifier items/total/createdBy
    // d'une commande via cette route générique (mass assignment).
    const allowedFields = ['statut', 'note', 'tableNumero'];
    const validStatuts = ['en-attente', 'en-preparation', 'prete', 'servie', 'annulee'];
    const update = { updatedAt: now.toISOString() };
    for (const field of allowedFields) {
      if (req.body[field] === undefined) continue;
      if (field === 'statut' && !validStatuts.includes(req.body.statut)) {
        return res.status(400).json({ error: 'Statut invalide' });
      }
      update[field] = req.body[field];
    }

    if (update.statut === 'prete') {
      update.validatedByCuisinier = req.user.username;
      update.validatedByCuisinierNom = req.user.nom;
    }

    await docRef.update(update);
    invalidate();
    eventBus.emit('commandes');

    if (update.statut && update.statut !== existing.statut) {
      const messages = {
        'en-preparation': { type: 'info',    icon: 'fire',           titre: 'En préparation', msg: `${existing.numero} – démarré en cuisine` },
        'prete':          { type: 'success', icon: 'check-circle',   titre: 'Commande prête', msg: `${existing.numero} – prête à servir !` },
        'servie':         { type: 'success', icon: 'concierge-bell', titre: 'Commande servie', msg: `${existing.numero} – servie au client` },
        'annulee':        { type: 'danger',  icon: 'times-circle',   titre: 'Commande annulée', msg: `${existing.numero} – annulée` },
      };
      const notif = messages[update.statut];
      if (notif) pushNotification({ type: notif.type, icon: notif.icon, titre: notif.titre, message: notif.msg, createdBy: req.user.username });

      if (update.statut === 'prete') {
        const hasBoissons = (existing.items || []).some(i => i.categorie === 'Boissons');
        const boissonsReady = !hasBoissons || existing.boissonsStatut === 'prete';
        const updatedCommande = { ...existing, ...update };

        // Bon interne cuisine (stocké en BD dès la validation cuisinière)
        await generateCuisineSubInvoice(req.params.id, updatedCommande, req.user.username, now);

        // Facture de paiement unifiée (seulement si le bar est déjà prêt aussi)
        if (boissonsReady) {
          await generateCombinedInvoice(
            req.params.id,
            updatedCommande,
            req.user.username,
            existing.validatedByBarman || '',
            now
          );
        }
      }
    }

    res.json({ id: req.params.id, ...existing, ...update });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/commandes/:id — annulation (admin uniquement)
router.delete('/:id', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    await db.collection('commandes').doc(req.params.id).update({
      statut: 'annulee',
      updatedAt: new Date().toISOString(),
    });
    invalidate();
    eventBus.emit('commandes');
    res.json({ message: 'Commande annulée' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

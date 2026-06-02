const express = require('express');
const { db } = require('../firebase-admin');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { pushNotification } = require('../utils/notifications');

const router = express.Router();

let _alertsCache = null;
let _alertsCacheTs = 0;
const ALERTS_TTL = 60_000;

// GET /api/stocks
router.get('/', authenticateToken, async (req, res) => {
  try {
    const snap = await db.collection('stocks').orderBy('nom').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stocks
router.post('/', authenticateToken, requireRole('directeur', 'cuisinier'), async (req, res) => {
  try {
    const { nom, categorie, quantite, minimum, unite } = req.body;
    if (!nom || quantite === undefined || !minimum) {
      return res.status(400).json({ error: 'Champs requis manquants' });
    }
    const data = {
      nom: nom.trim(),
      categorie: categorie || 'Ingrédients',
      quantite: Number(quantite),
      minimum: Number(minimum),
      unite: unite || 'kg',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const ref = await db.collection('stocks').add(data);

    pushNotification({
      type: 'success', icon: 'plus-circle',
      titre: 'Article de stock ajouté',
      message: `${data.nom} – ${data.quantite} ${data.unite} (min. ${data.minimum})`,
      createdBy: req.user.username,
    });

    res.status(201).json({ id: ref.id, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/stocks/:id
router.put('/:id', authenticateToken, requireRole('directeur', 'cuisinier'), async (req, res) => {
  try {
    const docRef = db.collection('stocks').doc(req.params.id);
    const doc = await docRef.get();

    const update = { ...req.body, updatedAt: new Date().toISOString() };
    delete update.id;
    if (update.quantite !== undefined) update.quantite = Number(update.quantite);
    await docRef.update(update);

    const existing = doc.exists ? doc.data() : {};
    const nom      = update.nom      || existing.nom      || req.params.id;
    const quantite = update.quantite !== undefined ? update.quantite : existing.quantite;
    const unite    = update.unite    || existing.unite    || '';

    const isAlert = quantite < (update.minimum || existing.minimum || 0);
    pushNotification({
      type: isAlert ? 'warning' : 'info', icon: 'boxes',
      titre: 'Stock mis à jour',
      message: `${nom} – ${quantite} ${unite}${isAlert ? ' ⚠️ STOCK BAS' : ''}`,
      createdBy: req.user.username,
    });

    _alertsCache = null;
    res.json({ id: req.params.id, ...update });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stocks/plats?date=YYYY-MM-DD
router.get('/plats', authenticateToken, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const snap = await db.collection('stocks_plats').where('date', '==', date).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stocks/plats — sauvegarder les quantités de plats préparés du jour
router.post('/plats', authenticateToken, requireRole('directeur', 'cuisinier'), async (req, res) => {
  try {
    const { plats, date } = req.body;
    if (!Array.isArray(plats) || plats.length === 0) {
      return res.status(400).json({ error: 'Liste de plats requise' });
    }
    const dateStr = date || new Date().toISOString().split('T')[0];
    const now = new Date().toISOString();

    for (const plat of plats) {
      // ID composé déterministe : évite les requêtes composées (pas d'index requis)
      const docId  = `${plat.menuItemId}_${dateStr}`;
      const docRef = db.collection('stocks_plats').doc(docId);
      const existing = await docRef.get();

      if (existing.exists) {
        const data = existing.data();
        const consomme = data.quantitePrepare - data.quantiteRestante;
        await docRef.update({
          quantitePrepare: plat.quantitePrepare,
          quantiteRestante: Math.max(0, plat.quantitePrepare - consomme),
          nom: plat.nom,
          updatedAt: now,
        });
      } else {
        await docRef.set({
          menuItemId: plat.menuItemId,
          nom: plat.nom,
          categorie: plat.categorie || '',
          date: dateStr,
          quantitePrepare: plat.quantitePrepare,
          quantiteRestante: plat.quantitePrepare,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    pushNotification({
      type: 'success', icon: 'utensils',
      titre: 'Stock plats mis à jour',
      message: `${plats.length} plat(s) configuré(s) pour le ${dateStr}`,
      createdBy: req.user.username,
    });

    res.json({ message: `Stock de ${plats.length} plat(s) enregistré`, date: dateStr });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stocks/alerts
router.get('/alerts', authenticateToken, async (req, res) => {
  try {
    if (_alertsCache && Date.now() - _alertsCacheTs < ALERTS_TTL) {
      return res.json(_alertsCache);
    }
    const snap = await db.collection('stocks').get();
    _alertsCache = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(s => s.quantite < s.minimum);
    _alertsCacheTs = Date.now();
    res.json(_alertsCache);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stocks/seed
router.post('/seed', authenticateToken, requireRole('directeur'), async (req, res) => {
  try {
    const snap = await db.collection('stocks').limit(1).get();
    if (!snap.empty) return res.status(409).json({ error: 'Stocks déjà initialisés' });

    const items = [
      { nom: 'Riz',           categorie: 'Féculents',    quantite: 50,  minimum: 20, unite: 'kg' },
      { nom: 'Huile de palme',categorie: 'Huiles',       quantite: 20,  minimum: 5,  unite: 'litres' },
      { nom: 'Poulet',        categorie: 'Viandes',      quantite: 30,  minimum: 10, unite: 'kg' },
      { nom: 'Poisson frais', categorie: 'Poissons',     quantite: 20,  minimum: 8,  unite: 'kg' },
      { nom: 'Tomates',       categorie: 'Légumes',      quantite: 15,  minimum: 5,  unite: 'kg' },
      { nom: 'Oignons',       categorie: 'Légumes',      quantite: 10,  minimum: 4,  unite: 'kg' },
      { nom: 'Bananes plantain',categorie: 'Légumes',    quantite: 50,  minimum: 20, unite: 'pièces' },
      { nom: 'Attiéké',       categorie: 'Féculents',    quantite: 30,  minimum: 10, unite: 'kg' },
      { nom: 'Pâte d\'arachide',categorie: 'Condiments', quantite: 10,  minimum: 3,  unite: 'kg' },
      { nom: 'Sel',           categorie: 'Épices',       quantite: 5,   minimum: 2,  unite: 'kg' },
      { nom: 'Piment',        categorie: 'Épices',       quantite: 3,   minimum: 1,  unite: 'kg' },
      { nom: 'Charbon',       categorie: 'Consommables', quantite: 100, minimum: 30, unite: 'kg' },
      { nom: 'Eau (bouteilles)',categorie: 'Boissons',   quantite: 120, minimum: 48, unite: 'bouteilles' },
      { nom: 'Sodas assortis', categorie: 'Boissons',   quantite: 48,  minimum: 24, unite: 'bouteilles' },
    ];

    const batch = db.batch();
    for (const item of items) {
      const ref = db.collection('stocks').doc();
      batch.set(ref, { ...item, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    await batch.commit();
    res.json({ message: `${items.length} articles de stock créés` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

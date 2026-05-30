const express = require('express');
const { db } = require('../firebase-admin');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { pushNotification } = require('../utils/notifications');

const router = express.Router();

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

    res.json({ id: req.params.id, ...update });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stocks/alerts
router.get('/alerts', authenticateToken, async (req, res) => {
  try {
    const snap = await db.collection('stocks').get();
    const alerts = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(s => s.quantite < s.minimum);
    res.json(alerts);
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

const express = require('express');
const { db } = require('../firebase-admin');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/menu
router.get('/', authenticateToken, async (req, res) => {
  try {
    const snap = await db.collection('menu').orderBy('categorie').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/menu
router.post('/', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { nom, categorie, prix, description, disponible } = req.body;
    if (!nom || prix === undefined) {
      return res.status(400).json({ error: 'Nom et prix sont requis' });
    }
    const data = {
      nom: nom.trim(),
      categorie: categorie || 'Plats',
      prix: Number(prix),
      description: description || '',
      disponible: disponible !== false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const ref = await db.collection('menu').add(data);
    res.status(201).json({ id: ref.id, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/menu/:id
router.put('/:id', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const update = { ...req.body, updatedAt: new Date().toISOString() };
    delete update.id;
    if (update.prix !== undefined) update.prix = Number(update.prix);
    await db.collection('menu').doc(req.params.id).update(update);
    res.json({ id: req.params.id, ...update });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/menu/:id
router.delete('/:id', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    await db.collection('menu').doc(req.params.id).delete();
    res.json({ message: 'Plat supprimé' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/menu/seed — plats par défaut
router.post('/seed', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const snap = await db.collection('menu').limit(1).get();
    if (!snap.empty) return res.status(409).json({ error: 'Menu déjà initialisé' });

    const plats = [
      { nom: 'Attiéké Poisson',      categorie: 'Plats',    prix: 2000, description: 'Attiéké avec poisson braisé', disponible: true },
      { nom: 'Riz Sauce Arachide',   categorie: 'Plats',    prix: 2500, description: 'Riz gras à la sauce arachide', disponible: true },
      { nom: 'Alloco Poulet',        categorie: 'Plats',    prix: 2500, description: 'Alloco avec poulet braisé', disponible: true },
      { nom: 'Foutou Soupe Graine',  categorie: 'Plats',    prix: 3000, description: 'Foutou banane avec soupe de graine', disponible: true },
      { nom: 'Placali Soupe Graine', categorie: 'Plats',    prix: 2500, description: 'Placali avec soupe de graine', disponible: true },
      { nom: 'Kedjénou Poulet',      categorie: 'Plats',    prix: 4000, description: 'Poulet kedjénou sauce tomate', disponible: true },
      { nom: 'Salade Mixte',         categorie: 'Entrées',  prix: 1500, description: 'Salade composée', disponible: true },
      { nom: 'Beignets Haricots',    categorie: 'Entrées',  prix: 500,  description: 'Beignets de haricots chauds', disponible: true },
      { nom: 'Eau Minérale 0.5L',    categorie: 'Boissons', prix: 500,  description: '', disponible: true },
      { nom: 'Coca-Cola',            categorie: 'Boissons', prix: 700,  description: '', disponible: true },
      { nom: 'Jus de Bissap',        categorie: 'Boissons', prix: 500,  description: 'Jus de bissap frais', disponible: true },
      { nom: 'Bière Locale',         categorie: 'Boissons', prix: 1000, description: '', disponible: true },
      { nom: 'Gâteau Maison',        categorie: 'Desserts', prix: 1000, description: 'Gâteau fait maison', disponible: true },
      { nom: 'Salade de Fruits',     categorie: 'Desserts', prix: 800,  description: '', disponible: true },
    ];

    const batch = db.batch();
    for (const p of plats) {
      const ref = db.collection('menu').doc();
      batch.set(ref, { ...p, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    await batch.commit();
    res.json({ message: `${plats.length} plats créés` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// Dépenses quotidiennes — administrateurs uniquement (lecture comme écriture).
// Une dépense n'est jamais effacée : DELETE la marque `supprimee` et chaque création,
// modification ou suppression est tracée dans son `historique` (voir utils/depenses.js).
const express = require('express');
const { db } = require('../firebase-admin');
const { authenticateToken, requireRole } = require('../middleware/auth');
const cache = require('../utils/cache');
const { validateDepense, entreeHistorique } = require('../utils/depenses');

const router = express.Router();
router.use(authenticateToken, requireRole('admin'));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function invalidate() {
  cache.delPrefix('depenses:');
  cache.delPrefix('stats:bilan:');
}

function todayUtc(now = new Date()) {
  return now.toISOString().split('T')[0];
}

// GET /api/depenses?debut=AAAA-MM-JJ&fin=AAAA-MM-JJ[&supprimees=1]
// Un seul filtre de plage sur `date` (pas d'index composite requis) ; les dépenses
// supprimées sont retirées en mémoire, sauf demande explicite (consultation de l'historique).
router.get('/', async (req, res) => {
  try {
    const { debut, fin, supprimees } = req.query;
    if ((debut && !DATE_RE.test(debut)) || (fin && !DATE_RE.test(fin))) {
      return res.status(400).json({ error: 'Date invalide (format attendu AAAA-MM-JJ)' });
    }

    const cacheKey = `depenses:${debut || ''}:${fin || ''}`;
    let all = cache.get(cacheKey);
    if (!all) {
      let q = db.collection('depenses');
      if (debut) q = q.where('date', '>=', debut);
      if (fin)   q = q.where('date', '<=', fin);
      const snap = await q.get();
      all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      cache.set(cacheKey, all, 60_000);
    }

    const depenses = (supprimees === '1' ? all : all.filter(d => !d.supprimee))
      .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));
    const total = depenses.filter(d => !d.supprimee).reduce((s, d) => s + (d.montant || 0), 0);
    res.json({ depenses, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/depenses
router.post('/', async (req, res) => {
  try {
    const now = new Date();
    const { data, error } = validateDepense(req.body, { today: todayUtc(now) });
    if (error) return res.status(400).json({ error });

    const doc = {
      ...data,
      supprimee: false,
      createdBy: req.user.username,
      createdByNom: req.user.nom || req.user.username,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      historique: [entreeHistorique('creation', req.user, now)],
    };
    const ref = await db.collection('depenses').add(doc);
    invalidate();
    res.status(201).json({ id: ref.id, ...doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/depenses/:id — modification partielle, valeurs précédentes gardées dans l'historique.
router.put('/:id', async (req, res) => {
  try {
    const now = new Date();
    const { data, error } = validateDepense(req.body, { partiel: true, today: todayUtc(now) });
    if (error) return res.status(400).json({ error });

    const ref = db.collection('depenses').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Dépense introuvable' });
    const existing = snap.data();
    if (existing.supprimee) return res.status(400).json({ error: 'Dépense supprimée, modification impossible' });

    const update = {
      ...data,
      updatedAt: now.toISOString(),
      historique: [...(existing.historique || []), entreeHistorique('modification', req.user, now, existing, data)],
    };
    await ref.update(update);
    invalidate();
    res.json({ id: req.params.id, ...existing, ...update });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/depenses/:id — suppression "douce" : retirée des listes et des totaux, mais
// conservée en base avec qui l'a supprimée et quand (la confirmation se fait côté client).
router.delete('/:id', async (req, res) => {
  try {
    const now = new Date();
    const ref = db.collection('depenses').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Dépense introuvable' });
    const existing = snap.data();
    if (existing.supprimee) return res.status(400).json({ error: 'Dépense déjà supprimée' });

    await ref.update({
      supprimee: true,
      supprimeeBy: req.user.username,
      supprimeeAt: now.toISOString(),
      updatedAt: now.toISOString(),
      historique: [...(existing.historique || []), entreeHistorique('suppression', req.user, now)],
    });
    invalidate();
    res.json({ message: 'Dépense supprimée' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

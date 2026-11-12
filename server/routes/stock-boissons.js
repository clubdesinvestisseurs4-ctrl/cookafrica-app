// Stock des boissons — voir utils/stockBoissons.js. Réservé à l'admin, comme les dépenses.
//   GET    /api/stock-boissons/etat?debut=&fin=         → stock, valeur, contrôle avec la caisse
//   GET    /api/stock-boissons/mouvements?debut=&fin=   → entrées / sorties saisies
//   POST   /api/stock-boissons/mouvements               → { date, sens, motif, note, lignes[] }
//   DELETE /api/stock-boissons/mouvements/:id           → suppression douce (gardée en base)
const express = require('express');
const { db } = require('../firebase-admin');
const { authenticateToken, requireRole } = require('../middleware/auth');
const cache = require('../utils/cache');
const { listeParPeriode, menuEnCache } = require('../utils/listes');
const { validerMouvement, calculerEtat } = require('../utils/stockBoissons');

const router = express.Router();
router.use(authenticateToken, requireRole('admin'));

const COLL = 'stock_boissons_mouvements';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);

const boissonsDuMenu = async () => (await menuEnCache()).filter(m => m.categorie === 'Boissons');

// Tous les mouvements (le stock se calcule depuis le premier) — une seule lecture, en cache.
const tousMouvements = () => cache.remember('stock-boissons:mouvements', 5 * 60_000, async () => {
  const snap = await db.collection(COLL).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
});

function lirePeriode(q) {
  const debut = q.debut || today();
  const fin = q.fin || debut;
  if (!DATE_RE.test(debut) || !DATE_RE.test(fin) || debut > fin) return null;
  return { debut, fin };
}

router.get('/etat', async (req, res) => {
  try {
    const p = lirePeriode(req.query);
    if (!p) return res.status(400).json({ error: 'Période invalide' });
    const [boissons, mouvements, factures] = await Promise.all([
      boissonsDuMenu(), tousMouvements(), listeParPeriode('factures', p.debut, p.fin),
    ]);
    res.json(calculerEtat({ boissons, mouvements, factures, ...p }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/mouvements', async (req, res) => {
  try {
    const p = lirePeriode(req.query);
    if (!p) return res.status(400).json({ error: 'Période invalide' });
    const liste = (await tousMouvements())
      .filter(m => !m.supprime && m.date >= p.debut && m.date <= p.fin)
      .sort((a, b) => b.date.localeCompare(a.date) || String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json(liste);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/mouvements', async (req, res) => {
  try {
    const boissons = new Map((await boissonsDuMenu()).map(b => [b.id, b]));
    const { data, error } = validerMouvement(req.body, boissons, today());
    if (error) return res.status(400).json({ error });
    const doc = {
      ...data, supprime: false,
      createdBy: req.user.username, createdByNom: req.user.nom || req.user.username, createdAt: new Date().toISOString(),
    };
    const ref = await db.collection(COLL).add(doc);
    cache.del('stock-boissons:mouvements');
    res.status(201).json({ id: ref.id, ...doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/mouvements/:id', async (req, res) => {
  try {
    const ref = db.collection(COLL).doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists || snap.data().supprime) return res.status(404).json({ error: 'Mouvement introuvable' });
    await ref.update({ supprime: true, supprimeBy: req.user.username, supprimeAt: new Date().toISOString() });
    cache.del('stock-boissons:mouvements');
    res.json({ message: 'Mouvement supprimé' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

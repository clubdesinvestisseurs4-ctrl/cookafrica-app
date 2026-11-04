const express = require('express');
const { db } = require('../firebase-admin');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

const FREE_READ_QUOTA = 50_000;

// Accès dédié à la surveillance automatisée (voir .github/workflows/firestore-quota-watch.yml)
// via une clé partagée distincte du login admin — le CI n'a ainsi jamais un vrai jeton
// admin en main. Sans cette clé, retombe sur l'auth admin classique (affichage éventuel
// côté app plus tard).
function quotaKeyOrAdmin(req, res, next) {
  const key = req.get('x-quota-key');
  if (process.env.QUOTA_MONITOR_KEY && key === process.env.QUOTA_MONITOR_KEY) return next();
  return authenticateToken(req, res, () => requireRole('admin')(req, res, next));
}

// GET /api/admin/quota — lectures Firestore comptabilisées aujourd'hui, tous processus
// confondus (Render + AWS Lambda partagent la même base — voir le compteur global dans
// firebase-admin.js, reversé ici toutes les minutes dans _meta/quotaLectures-<jour>).
router.get('/', quotaKeyOrAdmin, async (req, res) => {
  const day = new Date().toISOString().split('T')[0];
  try {
    // ?jour=AAAA-MM-JJ pour relire un jour passé (diagnostic après coup).
    const jour = /^\d{4}-\d{2}-\d{2}$/.test(req.query.jour || '') ? req.query.jour : day;
    const snap = await db.collection('_meta').doc(`quotaLectures-${jour}`).get();
    const count = snap.exists ? (snap.data().count || 0) : 0;
    const parRoute = Object.entries(snap.exists ? (snap.data().routes || {}) : {})
      .sort((a, b) => b[1] - a[1])
      .map(([route, lectures]) => ({ route, lectures }));
    res.json({
      day: jour,
      lecturesAujourdhui: count,
      quotaGratuit: FREE_READ_QUOTA,
      pourcentage: Math.round((count / FREE_READ_QUOTA) * 1000) / 10,
      parRoute,
    });
  } catch {
    res.status(500).json({ error: 'quota_unavailable' });
  }
});

module.exports = router;

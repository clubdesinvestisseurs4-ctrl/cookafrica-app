const express = require('express');
const { db } = require('../firebase-admin');
const { authenticateToken } = require('../middleware/auth');
const { listeNotifications, marquerToutesLuesEnCache } = require('../utils/notifications');

const router = express.Router();

// GET /api/notifications — admin voit tout, les autres reçoivent une liste vide (pas de 403)
// Liste en mémoire, complétée à chaque nouvelle notification (utils/notifications.js).
router.get('/', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.json([]);
  try {
    res.json(await listeNotifications());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/notifications/read — silencieux pour les non-admin
router.patch('/read', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.json({ updated: 0 });
  try {
    const snap = await db.collection('notifications').where('lu', '==', false).limit(100).get();
    if (snap.empty) return res.json({ updated: 0 });
    const batch = db.batch();
    snap.docs.forEach(d => batch.update(d.ref, { lu: true }));
    await batch.commit();
    marquerToutesLuesEnCache();
    res.json({ updated: snap.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

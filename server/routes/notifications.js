const express = require('express');
const { db } = require('../firebase-admin');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/notifications — 60 dernières (directeur uniquement)
router.get('/', authenticateToken, requireRole('directeur'), async (req, res) => {
  try {
    const snap = await db.collection('notifications')
      .orderBy('createdAt', 'desc')
      .limit(60)
      .get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/notifications/read — marquer toutes comme lues
router.patch('/read', authenticateToken, requireRole('directeur'), async (req, res) => {
  try {
    const snap = await db.collection('notifications').where('lu', '==', false).limit(100).get();
    if (snap.empty) return res.json({ updated: 0 });
    const batch = db.batch();
    snap.docs.forEach(d => batch.update(d.ref, { lu: true }));
    await batch.commit();
    res.json({ updated: snap.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

const express = require('express');
const { db } = require('../firebase-admin');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

let _notifCache = null;
let _notifCacheTs = 0;
const NOTIF_TTL = 60_000;

// GET /api/notifications — admin voit tout, les autres reçoivent une liste vide (pas de 403)
router.get('/', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.json([]);
  try {
    if (_notifCache && Date.now() - _notifCacheTs < NOTIF_TTL) {
      return res.json(_notifCache);
    }
    const snap = await db.collection('notifications')
      .orderBy('createdAt', 'desc')
      .limit(60)
      .get();
    _notifCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _notifCacheTs = Date.now();
    res.json(_notifCache);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function invalidateNotifCache() { _notifCache = null; }

// PATCH /api/notifications/read — silencieux pour les non-admin
router.patch('/read', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.json({ updated: 0 });
  try {
    const snap = await db.collection('notifications').where('lu', '==', false).limit(100).get();
    if (snap.empty) return res.json({ updated: 0 });
    const batch = db.batch();
    snap.docs.forEach(d => batch.update(d.ref, { lu: true }));
    await batch.commit();
    invalidateNotifCache();
    res.json({ updated: snap.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

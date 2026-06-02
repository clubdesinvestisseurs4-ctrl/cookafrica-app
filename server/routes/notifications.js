const express = require('express');
const { db } = require('../firebase-admin');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

let _notifCache = null;
let _notifCacheTs = 0;
const NOTIF_TTL = 60_000;

// GET /api/notifications — 60 dernières (directeur uniquement)
router.get('/', authenticateToken, requireRole('admin'), async (req, res) => {
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

// PATCH /api/notifications/read — marquer toutes comme lues
router.patch('/read', authenticateToken, requireRole('admin'), async (req, res) => {
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

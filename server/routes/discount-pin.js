const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../firebase-admin');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { getPinHash, invalidateCache } = require('../utils/discountPin');

const router = express.Router();

// GET /api/discount-pin — indique si un code est déjà configuré (admin)
router.get('/', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const hash = await getPinHash();
    res.json({ configured: !!hash });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/discount-pin — définit ou change le code (admin)
router.put('/', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin || !/^\d{4,8}$/.test(String(pin))) {
      return res.status(400).json({ error: 'Le code doit contenir entre 4 et 8 chiffres' });
    }

    const pinHash = await bcrypt.hash(String(pin), 10);
    await db.collection('settings').doc('discountPin').set({
      pinHash,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user.username,
    });
    invalidateCache();

    res.json({ message: 'Code mis à jour' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('../firebase-admin');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { getOtpDoc, getWindowMinutes, invalidateCache } = require('../utils/discountPin');

const router = express.Router();

// GET /api/discount-pin — statut de l'OTP en cours (admin + caissière : sert
// au client à savoir si la fenêtre ouverte par un code déjà saisi est encore
// valide, sans jamais révéler le code lui-même)
router.get('/', authenticateToken, requireRole('admin', 'caissiere', 'caissier-en-ligne'), async (req, res) => {
  try {
    const otp = await getOtpDoc();
    const windowMinutes = await getWindowMinutes();
    const active = !!(otp?.expiresAt && new Date(otp.expiresAt).getTime() > Date.now());
    res.json({ active, expiresAt: active ? otp.expiresAt : null, windowMinutes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/discount-pin/config — règle la durée de la fenêtre en minutes (admin)
router.put('/config', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const minutes = Number(req.body.windowMinutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
      return res.status(400).json({ error: 'La durée doit être un nombre entier de minutes, entre 1 et 60' });
    }
    await db.collection('settings').doc('discountOtpConfig').set({
      windowMinutes: minutes,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user.username,
    });
    res.json({ message: 'Durée mise à jour', windowMinutes: minutes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/discount-pin/generate — génère un nouveau code temporaire (admin).
// Le code en clair n'est renvoyé qu'une fois, dans cette réponse : à l'admin
// de le communiquer oralement à la caissière. Remplace tout code en cours.
router.post('/generate', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const windowMinutes = await getWindowMinutes();
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + windowMinutes * 60 * 1000).toISOString();

    await db.collection('settings').doc('discountOtp').set({
      codeHash,
      expiresAt,
      generatedAt: new Date().toISOString(),
      generatedBy: req.user.username,
    });
    invalidateCache();

    res.json({ code, expiresAt, windowMinutes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
const express = require('express');
const { db } = require('../firebase-admin');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { getClientIp, getConfig, invalidateCache } = require('../utils/wifi');

const router = express.Router();

const DOC_REF = () => db.collection('settings').doc('wifiConfig');

// GET /api/wifi-config — config actuelle + IP du client (admin)
router.get('/', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const config = await getConfig();
    res.json({
      enabled:    config.enabled    ?? false,
      allowedIps: config.allowedIps ?? [],
      currentIp:  getClientIp(req),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/wifi-config/add — ajoute l'IP courante (ou une IP fournie) à la liste
router.post('/add', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const ip = req.body.ip || getClientIp(req);
    if (!ip) return res.status(400).json({ error: 'IP introuvable' });

    const config = await getConfig();
    const current = config.allowedIps ?? [];
    if (current.includes(ip)) return res.json({ message: 'IP déjà dans la liste', allowedIps: current });

    const updated = [...current, ip];
    await DOC_REF().set({ enabled: config.enabled ?? false, allowedIps: updated }, { merge: true });
    invalidateCache();
    res.json({ message: 'Réseau ajouté', allowedIps: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/wifi-config/remove — supprime une IP de la liste
router.delete('/remove', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ error: 'IP requise' });

    const config = await getConfig();
    const updated = (config.allowedIps ?? []).filter(x => x !== ip);
    await DOC_REF().set({ enabled: config.enabled ?? false, allowedIps: updated }, { merge: true });
    invalidateCache();
    res.json({ message: 'IP supprimée', allowedIps: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/wifi-config/toggle — active ou désactive la restriction
router.patch('/toggle', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const config = await getConfig();
    const enabled = !(config.enabled ?? false);
    await DOC_REF().set({ enabled, allowedIps: config.allowedIps ?? [] }, { merge: true });
    invalidateCache();
    res.json({ message: enabled ? 'Restriction activée' : 'Restriction désactivée', enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

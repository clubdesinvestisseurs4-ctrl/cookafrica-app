const crypto = require('crypto');

// Authentification serveur-à-serveur pour les routes /api/integration, consommées par
// d'autres applications internes (ex: ERP-Compta) via une clé partagée, sans JWT utilisateur.
// Même mécanique que gestion-employees/server/middleware/serviceAuth.js.
function authenticateService(req, res, next) {
  const key = req.headers['x-service-key'];
  const expected = process.env.INTEGRATION_API_KEY;

  // Comparaison à temps constant pour éviter une attaque par timing sur la clé partagée.
  const keyBuf = Buffer.from(String(key || ''));
  const expectedBuf = Buffer.from(String(expected || ''));
  const valid = Boolean(expected) && keyBuf.length === expectedBuf.length && crypto.timingSafeEqual(keyBuf, expectedBuf);

  if (!valid) {
    return res.status(401).json({ error: 'Clé de service invalide' });
  }
  next();
}

module.exports = { authenticateService };
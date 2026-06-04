const jwt = require('jsonwebtoken');
const { isAllowedIp } = require('../utils/wifi');

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Token requis' });
  }

  jwt.verify(token, process.env.JWT_SECRET, async (err, user) => {
    if (err) {
      return res.status(401).json({ error: 'Token invalide ou expiré' });
    }
    req.user = user;
    // L'admin peut se connecter depuis n'importe quel réseau.
    if (user.role !== 'admin' && !(await isAllowedIp(req))) {
      return res.status(403).json({ error: 'wifi_restricted' });
    }
    next();
  });
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Accès refusé' });
    }
    next();
  };
}

module.exports = { authenticateToken, requireRole };

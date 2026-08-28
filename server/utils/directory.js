// Jetons courts utilisés par le flux de bascule inter-site (voir routes/directory.js
// et le nouvel endpoint POST /api/auth/exchange-switch-token dans routes/auth.js).
// Volontairement signés avec des secrets distincts de JWT_SECRET : ni l'un ni l'autre
// n'est un jeton de session valide sur authenticateToken, même s'il était intercepté.
const jwt = require('jsonwebtoken');

// Jeton de session d'annuaire : prouve qu'un admin multi-site a passé la vérification
// de mot de passe de l'annuaire. Courte durée — le temps de choisir un site dans l'UI.
function signDirectorySession(directoryId) {
  return jwt.sign({ directoryId }, process.env.DIRECTORY_SESSION_SECRET, { expiresIn: '5m' });
}
function verifyDirectorySession(token) {
  return jwt.verify(token, process.env.DIRECTORY_SESSION_SECRET);
}

// Jeton de bascule : prouve qu'un utilisateur précis a le droit de rejoindre un site
// précis. Consommé une seule fois par POST /api/auth/exchange-switch-token sur le
// backend de ce site, qui revérifie l'utilisateur dans sa propre base avant de signer
// un vrai jeton avec son propre JWT_SECRET (jamais partagé avec l'annuaire).
function signSwitchToken({ userId, siteId }) {
  return jwt.sign({ userId, siteId }, process.env.DIRECTORY_SWITCH_SECRET, { expiresIn: '2m' });
}
function verifySwitchToken(token) {
  return jwt.verify(token, process.env.DIRECTORY_SWITCH_SECRET);
}

module.exports = { signDirectorySession, verifyDirectorySession, signSwitchToken, verifySwitchToken };

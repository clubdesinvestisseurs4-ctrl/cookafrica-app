// Jetons courts utilisés par le flux de bascule inter-site (voir routes/directory.js
// et le nouvel endpoint POST /api/auth/exchange-switch-token dans routes/auth.js).
// Volontairement signés avec des secrets distincts de JWT_SECRET : ni l'un ni l'autre
// n'est un jeton de session valide sur authenticateToken, même s'il était intercepté.
const jwt = require('jsonwebtoken');

// Jeton de session d'annuaire : prouve qu'un admin multi-site a passé la vérification
// de mot de passe de l'annuaire. Même durée que la session normale d'un site (12h) —
// mémorisé côté client (voir openSwitchSite() dans app.js) pour ne pas redemander ce
// mot de passe à chaque bascule. Reste un jeton de faible privilège : il ne permet que
// de lister les sites accessibles et d'obtenir un jeton de bascule pour l'un d'eux,
// jamais d'agir directement sur des données métier.
function signDirectorySession(directoryId) {
  return jwt.sign({ directoryId }, process.env.DIRECTORY_SESSION_SECRET, { expiresIn: '12h' });
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

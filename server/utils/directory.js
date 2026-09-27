// Jetons courts utilisés par le flux de bascule inter-site (voir routes/directory.js
// et le nouvel endpoint POST /api/auth/exchange-switch-token dans routes/auth.js).
// Volontairement signés avec des secrets distincts de JWT_SECRET : ni l'un ni l'autre
// n'est un jeton de session valide sur authenticateToken, même s'il était intercepté.
const jwt = require('jsonwebtoken');
const { db } = require('../firebase-admin');

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

// Jeton de "caution" inter-sites : un site SECONDAIRE (pas le site maison) le signe
// pour certifier "j'ai vérifié moi-même, avec mon propre JWT_SECRET, que cet
// utilisateur est un admin authentifié chez moi" — sans jamais transmettre ce
// JWT_SECRET au site maison. Signé avec un troisième secret, partagé cette fois entre
// TOUS les backends (comme DIRECTORY_SWITCH_SECRET, dans l'autre sens), mais qui ne
// sert qu'à interroger l'annuaire pour un username donné — jamais à agir sur des
// données métier. Durée de vie très courte : juste l'aller-retour serveur-à-serveur,
// jamais transmis au navigateur (voir GET /api/auth/directory-sites).
function signVouchToken(username) {
  return jwt.sign({ username }, process.env.DIRECTORY_VOUCH_SECRET, { expiresIn: '30s' });
}
function verifyVouchToken(token) {
  return jwt.verify(token, process.env.DIRECTORY_VOUCH_SECRET);
}

// Recherche partagée par POST /api/directory/my-sites (site maison, jeton normal) et
// POST /api/directory/vouch (site secondaire, jeton de caution) — même résultat,
// seule la façon de prouver l'identité diffère. Ne vit que dans la base du site
// maison, où réside l'annuaire (voir DIRECTORY_ENABLED).
async function lookupDirectorySites(username) {
  const dirSnapshot = await db.collection('admin_directory')
    .where('username', '==', username.toLowerCase().trim())
    .limit(1).get();
  if (dirSnapshot.empty) return null;
  const doc = dirSnapshot.docs[0];
  const account = doc.data();
  return {
    directoryToken: signDirectorySession(doc.id),
    sites: (account.sites || []).map(s => ({ siteId: s.siteId, label: s.label })),
  };
}

module.exports = {
  signDirectorySession, verifyDirectorySession,
  signSwitchToken, verifySwitchToken,
  signVouchToken, verifyVouchToken,
  lookupDirectorySites,
};

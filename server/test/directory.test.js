// Tests des jetons de bascule inter-site (utils/directory.js) — logique pure
// (signature/vérification JWT), aucune dépendance Firestore.
const test = require('node:test');
const assert = require('node:assert');

process.env.DIRECTORY_SESSION_SECRET = 'test-directory-session-secret';
process.env.DIRECTORY_SWITCH_SECRET  = 'test-directory-switch-secret';

const {
  signDirectorySession, verifyDirectorySession,
  signSwitchToken, verifySwitchToken,
} = require('../utils/directory');

test('signDirectorySession / verifyDirectorySession — aller-retour correct', () => {
  const token = signDirectorySession('dir123');
  const payload = verifyDirectorySession(token);
  assert.strictEqual(payload.directoryId, 'dir123');
});

test('signSwitchToken / verifySwitchToken — aller-retour correct', () => {
  const token = signSwitchToken({ userId: 'user456', siteId: 'dubai' });
  const payload = verifySwitchToken(token);
  assert.strictEqual(payload.userId, 'user456');
  assert.strictEqual(payload.siteId, 'dubai');
});

test('les deux types de jetons utilisent des secrets distincts — non interchangeables', () => {
  const directoryToken = signDirectorySession('dir123');
  assert.throws(() => verifySwitchToken(directoryToken));

  const switchToken = signSwitchToken({ userId: 'user456', siteId: 'dubai' });
  assert.throws(() => verifyDirectorySession(switchToken));
});

test('un jeton de bascule falsifié (mauvais secret) est rejeté', () => {
  const jwt = require('jsonwebtoken');
  const forged = jwt.sign({ userId: 'attacker', siteId: 'dubai' }, 'mauvais-secret');
  assert.throws(() => verifySwitchToken(forged));
});

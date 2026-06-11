// Tests de sécurité — exécutés avant chaque déploiement (npm test).
// Ne nécessitent pas Firebase/JWT_SECRET : ils ciblent uniquement la logique
// pure (CORS, IP, whitelist de champs, contrôle de rôle).
const test = require('node:test');
const assert = require('node:assert');

const corsOrigins = require('../config/corsOrigins');
const { ipInCidr, normalizeIp, getClientIp } = require('../utils/wifi');
const { buildCommandeUpdate, ALLOWED_FIELDS } = require('../utils/commandeUpdate');
const { requireRole } = require('../middleware/auth');

// ─── CORS ───────────────────────────────────────────────────────────────────

function isOriginAllowed(origin) {
  return corsOrigins.some(o => (o instanceof RegExp ? o.test(origin) : o === origin));
}

test('CORS — autorise le frontend Vercel du projet', () => {
  assert.ok(isOriginAllowed('https://cookafrica-app.vercel.app'));
  assert.ok(isOriginAllowed('https://cookafrica-app-git-main-monteam.vercel.app'));
});

test('CORS — refuse un autre projet *.vercel.app (anti phishing)', () => {
  assert.ok(!isOriginAllowed('https://evil-phisher.vercel.app'));
  assert.ok(!isOriginAllowed('https://cookafrica-appfake.vercel.app'));
});

test('CORS — refuse une origine arbitraire', () => {
  assert.ok(!isOriginAllowed('https://attacker.com'));
});

// ─── Restriction Wi-Fi / IP ─────────────────────────────────────────────────

test('wifi — ipInCidr matche correctement une plage', () => {
  assert.ok(ipInCidr('192.168.1.42', '192.168.1.0/24'));
  assert.ok(!ipInCidr('192.168.2.42', '192.168.1.0/24'));
});

test('wifi — normalizeIp retire le préfixe IPv4-mapped IPv6', () => {
  assert.strictEqual(normalizeIp('::ffff:203.0.113.5'), '203.0.113.5');
  assert.strictEqual(normalizeIp('203.0.113.5'), '203.0.113.5');
});

test('wifi — getClientIp utilise CF-Connecting-IP (Cloudflare) en priorité', () => {
  const req = {
    headers: { 'cf-connecting-ip': '196.192.120.121' },
    ip: '10.26.145.3', // IP interne du load-balancer Render
  };
  assert.strictEqual(getClientIp(req), '196.192.120.121');
});

test('wifi — getClientIp retombe sur req.ip si CF-Connecting-IP est absent', () => {
  const req = { headers: {}, ip: '203.0.113.7' };
  assert.strictEqual(getClientIp(req), '203.0.113.7');
});

test('wifi — getClientIp ignore un X-Forwarded-For falsifié par le client', () => {
  const req = {
    headers: {
      'cf-connecting-ip': '196.192.120.121',
      'x-forwarded-for': '1.2.3.4', // valeur que le client pourrait usurper
    },
    ip: '10.26.145.3',
  };
  assert.strictEqual(getClientIp(req), '196.192.120.121');
});

// ─── Mass assignment sur PUT /api/commandes/:id ────────────────────────────

test('commandes — seuls les champs autorisés sont retenus', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const { update, error } = buildCommandeUpdate({
    statut: 'prete',
    note: 'Sans piment',
    tableNumero: '5',
    total: 0,            // tentative de fraude
    items: [],           // tentative de fraude
    createdBy: 'attaquant',
  }, now);

  assert.strictEqual(error, undefined);
  assert.strictEqual(update.statut, 'prete');
  assert.strictEqual(update.note, 'Sans piment');
  assert.strictEqual(update.tableNumero, '5');
  assert.strictEqual(update.total, undefined, 'total ne doit pas être modifiable');
  assert.strictEqual(update.items, undefined, 'items ne doit pas être modifiable');
  assert.strictEqual(update.createdBy, undefined, 'createdBy ne doit pas être modifiable');

  for (const key of Object.keys(update)) {
    assert.ok(
      ALLOWED_FIELDS.includes(key) || key === 'updatedAt',
      `champ inattendu dans la mise à jour : ${key}`
    );
  }
});

test('commandes — un statut invalide est rejeté', () => {
  const { error, update } = buildCommandeUpdate({ statut: 'hacked' }, new Date());
  assert.strictEqual(error, 'Statut invalide');
  assert.strictEqual(update, undefined);
});

// ─── Contrôle de rôle ───────────────────────────────────────────────────────

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('requireRole — bloque un rôle non autorisé', () => {
  const req = { user: { role: 'cuisiniere' } };
  const res = mockRes();
  let nextCalled = false;
  requireRole('admin')(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 403);
});

test('requireRole — laisse passer le bon rôle', () => {
  const req = { user: { role: 'admin' } };
  const res = mockRes();
  let nextCalled = false;
  requireRole('admin')(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.statusCode, null);
});

test('requireRole — refuse si req.user est absent (token manquant en amont)', () => {
  const req = {};
  const res = mockRes();
  let nextCalled = false;
  requireRole('admin')(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 403);
});

// Tests de sécurité — exécutés avant chaque déploiement (npm test).
// Ne nécessitent pas Firebase/JWT_SECRET : ils ciblent uniquement la logique
// pure (CORS, IP, whitelist de champs, contrôle de rôle).
const test = require('node:test');
const assert = require('node:assert');

const corsOrigins = require('../config/corsOrigins');
const { ipInCidr, normalizeIp, getClientIp } = require('../utils/wifi');
const { buildCommandeUpdate, ALLOWED_FIELDS } = require('../utils/commandeUpdate');
const { requireRole } = require('../middleware/auth');
const { resolvePublicItems, resolvePublicContact, MAX_LIGNES, MAX_QTE_PAR_LIGNE } = require('../utils/publicCommande');

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
    statut: 'servie',
    note: 'Sans piment',
    tableNumero: '5',
    total: 0,            // tentative de fraude
    items: [],           // tentative de fraude
    createdBy: 'attaquant',
  }, now);

  assert.strictEqual(error, undefined);
  assert.strictEqual(update.statut, 'servie');
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

// ─── Commande publique (client) — le prix vient toujours du serveur ───────

const MENU_TEST = [
  { id: 'm1', nom: 'Attiéké Poisson', prix: 2000, categorie: 'Plats', disponible: true },
  { id: 'm2', nom: 'Coca-Cola',       prix: 700,  categorie: 'Boissons', disponible: true },
  { id: 'm3', nom: 'Plat épuisé',     prix: 5000, categorie: 'Plats', disponible: false },
];

test('resolvePublicItems — refuse un panier vide', () => {
  const { error } = resolvePublicItems([], MENU_TEST);
  assert.strictEqual(error, 'Le panier est vide');
});

test('resolvePublicItems — ignore le prix envoyé par le client et reprend celui du menu', () => {
  // Un client malveillant modifie sa requête pour tenter de payer 1 FCFA.
  const { items, total, error } = resolvePublicItems(
    [{ menuItemId: 'm1', quantite: 2, prix: 1, nom: 'GRATUIT' }],
    MENU_TEST
  );
  assert.strictEqual(error, undefined);
  assert.strictEqual(items[0].prix, 2000, 'le prix doit venir du menu serveur, pas de la requête');
  assert.strictEqual(items[0].nom, 'Attiéké Poisson', 'le nom doit venir du menu serveur, pas de la requête');
  assert.strictEqual(total, 4000);
});

test('resolvePublicItems — refuse un article introuvable au menu', () => {
  const { error } = resolvePublicItems([{ menuItemId: 'inconnu', quantite: 1 }], MENU_TEST);
  assert.strictEqual(error, 'Un article du panier n\'existe plus au menu');
});

test('resolvePublicItems — refuse un article marqué indisponible', () => {
  const { error } = resolvePublicItems([{ menuItemId: 'm3', quantite: 1 }], MENU_TEST);
  assert.match(error, /n'est plus disponible/);
});

test('resolvePublicItems — refuse une quantité nulle, négative ou non numérique', () => {
  assert.ok(resolvePublicItems([{ menuItemId: 'm1', quantite: 0 }], MENU_TEST).error);
  assert.ok(resolvePublicItems([{ menuItemId: 'm1', quantite: -3 }], MENU_TEST).error);
  assert.ok(resolvePublicItems([{ menuItemId: 'm1', quantite: 'beaucoup' }], MENU_TEST).error);
});

test('resolvePublicItems — refuse une quantité supérieure au maximum autorisé', () => {
  const { error } = resolvePublicItems([{ menuItemId: 'm1', quantite: MAX_QTE_PAR_LIGNE + 1 }], MENU_TEST);
  assert.ok(error);
});

test('resolvePublicItems — refuse un panier avec trop de lignes distinctes', () => {
  const items = Array.from({ length: MAX_LIGNES + 1 }, () => ({ menuItemId: 'm1', quantite: 1 }));
  const { error } = resolvePublicItems(items, MENU_TEST);
  assert.ok(error);
});

// ─── Coordonnées client (commande publique) — obligatoires + lien Maps fiable ──

const CONTACT_VALIDE = { prenom: 'Awa', nom: 'Koné', telephone: '07 00 00 00 00', localisation: { lat: 5.36, lng: -4.01 } };

test('resolvePublicContact — accepte des coordonnées valides et construit mapsUrl', () => {
  const { contact, error } = resolvePublicContact(CONTACT_VALIDE);
  assert.strictEqual(error, undefined);
  assert.strictEqual(contact.prenom, 'Awa');
  assert.strictEqual(contact.nom, 'Koné');
  assert.strictEqual(contact.localisation.mapsUrl, 'https://www.google.com/maps?q=5.36,-4.01');
});

test('resolvePublicContact — ignore un mapsUrl envoyé par le client et le reconstruit', () => {
  const { contact } = resolvePublicContact({
    ...CONTACT_VALIDE,
    localisation: { lat: 5.36, lng: -4.01, mapsUrl: 'https://evil.example/phishing' },
  });
  assert.strictEqual(contact.localisation.mapsUrl, 'https://www.google.com/maps?q=5.36,-4.01');
});

test('resolvePublicContact — refuse un prénom ou un nom manquant', () => {
  assert.ok(resolvePublicContact({ ...CONTACT_VALIDE, prenom: '' }).error);
  assert.ok(resolvePublicContact({ ...CONTACT_VALIDE, nom: '  ' }).error);
});

test('resolvePublicContact — refuse un téléphone trop court', () => {
  assert.ok(resolvePublicContact({ ...CONTACT_VALIDE, telephone: '070000' }).error);
});

test('resolvePublicContact — refuse une localisation absente ou hors limites', () => {
  assert.ok(resolvePublicContact({ ...CONTACT_VALIDE, localisation: undefined }).error);
  assert.ok(resolvePublicContact({ ...CONTACT_VALIDE, localisation: { lat: 200, lng: -4.01 } }).error);
  assert.ok(resolvePublicContact({ ...CONTACT_VALIDE, localisation: { lat: 5.36, lng: 'nawak' } }).error);
});

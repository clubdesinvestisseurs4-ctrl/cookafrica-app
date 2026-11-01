// Règles sur place / à emporter à la création et à la correction (demande du 2026-11-01).
const test = require('node:test');
const assert = require('node:assert');

const { modeParDefaut, resolveModeConsommation } = require('../utils/commandes');
const { buildCommandeUpdate } = require('../utils/commandeUpdate');

const PLAT = { nom: 'Attiéké Poisson', categorie: 'Plats (sauce)' };
const BOISSON = { nom: 'Coca-Cola', categorie: 'Boissons' };
const BUFFET = { nom: 'Buffet Mixte', categorie: 'Buffet' };

test('serveur -> toujours "sur place" par défaut, même sans boisson', () => {
  assert.strictEqual(modeParDefaut('serveur', [PLAT]), 'sur-place');
});

for (const role of ['caissiere', 'admin', 'caissier-en-ligne', 'client-web']) {
  test(`${role} sans boisson ni buffet -> "à emporter"`, () => {
    assert.strictEqual(modeParDefaut(role, [PLAT]), 'a-emporter');
  });
  test(`${role} avec boisson -> "sur place"`, () => {
    assert.strictEqual(modeParDefaut(role, [PLAT, BOISSON]), 'sur-place');
  });
  test(`${role} avec buffet -> "sur place"`, () => {
    assert.strictEqual(modeParDefaut(role, [BUFFET]), 'sur-place');
  });
}

test('choix identique à la règle -> source "auto"', () => {
  assert.deepStrictEqual(resolveModeConsommation('a-emporter', 'caissiere', [PLAT]),
    { modeConsommation: 'a-emporter', modeSource: 'auto' });
});

test('correction manuelle avant validation -> source "manuel"', () => {
  assert.deepStrictEqual(resolveModeConsommation('a-emporter', 'serveur', [PLAT, BOISSON]),
    { modeConsommation: 'a-emporter', modeSource: 'manuel' });
});

test('mode absent ou inconnu (ancien client, file hors-ligne) -> règle automatique', () => {
  assert.deepStrictEqual(resolveModeConsommation(undefined, 'caissiere', [PLAT, BOISSON]),
    { modeConsommation: 'sur-place', modeSource: 'auto' });
  assert.deepStrictEqual(resolveModeConsommation('livraison', 'caissiere', [PLAT]),
    { modeConsommation: 'a-emporter', modeSource: 'auto' });
});

test('correction après coup : admin/caisse autorisés, marquée manuelle et non estimée', () => {
  const { update, error } = buildCommandeUpdate({ modeConsommation: 'a-emporter' }, new Date(), 'caissiere');
  assert.strictEqual(error, undefined);
  assert.strictEqual(update.modeConsommation, 'a-emporter');
  assert.strictEqual(update.modeSource, 'manuel');
  assert.strictEqual(update.modeEstime, false);
});

test('correction après coup : refusée au serveur (403) et valeur invalide rejetée', () => {
  const refus = buildCommandeUpdate({ modeConsommation: 'a-emporter' }, new Date(), 'serveur');
  assert.strictEqual(refus.status, 403);
  const invalide = buildCommandeUpdate({ modeConsommation: 'livraison' }, new Date(), 'admin');
  assert.strictEqual(invalide.error, 'Mode de consommation invalide');
});

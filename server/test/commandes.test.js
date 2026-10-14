// Tests du classement automatique sur place / à emporter — logique pure, aucune
// dépendance Firebase.
const test = require('node:test');
const assert = require('node:assert');

const { determineModeConsommation } = require('../utils/commandes');

test('determineModeConsommation — une boisson classe la commande "sur-place"', () => {
  const items = [
    { nom: 'Attiéké Poisson', categorie: 'Plats' },
    { nom: 'Coca-Cola', categorie: 'Boissons' },
  ];
  assert.strictEqual(determineModeConsommation(items), 'sur-place');
});

test('determineModeConsommation — un buffet classe la commande "sur-place"', () => {
  const items = [{ nom: 'Buffet Mixte', categorie: 'Plats' }]; // mal catégorisé exprès
  assert.strictEqual(determineModeConsommation(items), 'sur-place');
});

test('determineModeConsommation — aucune boisson ni buffet -> "a-emporter"', () => {
  const items = [
    { nom: 'Attiéké Poisson', categorie: 'Plats' },
    { nom: 'Gâteau Maison', categorie: 'Desserts' },
  ];
  assert.strictEqual(determineModeConsommation(items), 'a-emporter');
});

test('determineModeConsommation — insensible à la casse et aux accents', () => {
  assert.strictEqual(determineModeConsommation([{ nom: 'Jus', categorie: 'BOISSON' }]), 'sur-place');
  assert.strictEqual(determineModeConsommation([{ nom: 'bufFET du jour', categorie: '' }]), 'sur-place');
});

test('determineModeConsommation — liste vide ou absente -> "a-emporter"', () => {
  assert.strictEqual(determineModeConsommation([]), 'a-emporter');
  assert.strictEqual(determineModeConsommation(undefined), 'a-emporter');
});

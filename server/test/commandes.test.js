// Tests du classement automatique sur place / à emporter — logique pure, aucune
// dépendance Firebase.
const test = require('node:test');
const assert = require('node:assert');

const { determineModeConsommation, resolveCommandeDate } = require('../utils/commandes');

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

const NOW = new Date('2026-10-15T12:00:00Z');

test('resolveCommandeDate — aucune date fournie -> aujourd\'hui', () => {
  assert.deepStrictEqual(resolveCommandeDate(undefined, 'admin', NOW), { date: '2026-10-15' });
});

test('resolveCommandeDate — admin peut antidater dans la fenêtre autorisée', () => {
  assert.deepStrictEqual(resolveCommandeDate('2026-10-14', 'admin', NOW), { date: '2026-10-14' });
});

test('resolveCommandeDate — caissière peut aussi antidater', () => {
  assert.deepStrictEqual(resolveCommandeDate('2026-10-14', 'caissiere', NOW), { date: '2026-10-14' });
});

test('resolveCommandeDate — serveur/caissier-en-ligne : date ignorée, retombe sur aujourd\'hui', () => {
  assert.deepStrictEqual(resolveCommandeDate('2026-10-14', 'serveur', NOW), { date: '2026-10-15' });
  assert.deepStrictEqual(resolveCommandeDate('2026-10-14', 'caissier-en-ligne', NOW), { date: '2026-10-15' });
});

test('resolveCommandeDate — refuse un format invalide', () => {
  assert.deepStrictEqual(resolveCommandeDate('14/10/2026', 'admin', NOW), { error: 'Date invalide (format attendu AAAA-MM-JJ)' });
});

test('resolveCommandeDate — refuse une date future', () => {
  assert.deepStrictEqual(resolveCommandeDate('2026-10-16', 'admin', NOW), { error: 'La date ne peut pas être dans le futur' });
});

test('resolveCommandeDate — accepte la borne exacte (30 jours), refuse au-delà', () => {
  assert.deepStrictEqual(resolveCommandeDate('2026-09-15', 'admin', NOW), { date: '2026-09-15' });
  const res = resolveCommandeDate('2026-09-14', 'admin', NOW);
  assert.ok(res.error);
});

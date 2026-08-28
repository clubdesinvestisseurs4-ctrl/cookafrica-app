// Tests du formatage de devise par site (CURRENCY_LABEL/CURRENCY_LOCALE) — logique
// pure, aucune dépendance Firebase.
const test = require('node:test');
const assert = require('node:assert');

const { formatMontant } = require('../utils/currency');

test('formatMontant — utilise FCFA/fr-FR par défaut si aucune variable d\'env', () => {
  delete process.env.CURRENCY_LABEL;
  delete process.env.CURRENCY_LOCALE;
  // Le séparateur de milliers fr-FR est une espace insécable fine (U+202F), pas
  // une espace normale — on compare au résultat natif de toLocaleString plutôt
  // qu'à un littéral, pour ne pas dépendre du caractère exact.
  assert.strictEqual(formatMontant(15000), `${(15000).toLocaleString('fr-FR')} FCFA`);
});

test('formatMontant — traite une valeur absente/nulle comme 0', () => {
  delete process.env.CURRENCY_LABEL;
  delete process.env.CURRENCY_LOCALE;
  assert.strictEqual(formatMontant(undefined), '0 FCFA');
  assert.strictEqual(formatMontant(null), '0 FCFA');
});

test('formatMontant — respecte CURRENCY_LABEL/CURRENCY_LOCALE (site Dubaï)', () => {
  process.env.CURRENCY_LABEL = 'USD';
  process.env.CURRENCY_LOCALE = 'en-US';
  try {
    assert.strictEqual(formatMontant(15000), '15,000 USD');
  } finally {
    delete process.env.CURRENCY_LABEL;
    delete process.env.CURRENCY_LOCALE;
  }
});

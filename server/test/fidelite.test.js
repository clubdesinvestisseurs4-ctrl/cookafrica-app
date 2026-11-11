const test = require('node:test');
const assert = require('node:assert');
const f = require('../utils/fidelite');

const buffet = [{ nom: 'Buffet midi', categorie: 'Buffet', prix: 10_000, quantite: 1, sousTotal: 10_000 }];

test('éligible : sur place, ≥ 10 000, avec un buffet', () => {
  assert.ok(f.estEligible({ total: 10_000, items: buffet, modeConsommation: 'sur-place' }));
  assert.ok(f.estEligible({ total: 15_000, items: buffet }));
  assert.ok(!f.estEligible({ total: 9_999, items: buffet, modeConsommation: 'sur-place' }));
  assert.ok(!f.estEligible({ total: 30_000, items: buffet, modeConsommation: 'a-emporter' }));
  assert.ok(!f.estEligible({ total: 30_000, items: [{ categorie: 'Plats' }], modeConsommation: 'sur-place' }));
});

test('chaque palier totalise 100 %, jus ≤ 25 %, plat jamais au palier bronze', () => {
  for (const p of f.PALIERS) {
    assert.strictEqual(Object.values(p.chances).reduce((a, b) => a + b, 0), 100, p.nom);
    assert.ok(p.chances.jus <= 25);
    assert.ok(p.chances.accompagnement >= Math.max(p.chances.jus, p.chances.remise10, p.chances.plat));
  }
  for (let a = 0; a < 100; a++) assert.notStrictEqual(f.tirerLot(12_000, a).type, 'plat');
});

test('plus l\'addition est élevée, plus le plat offert est probable', () => {
  const nbPlats = (total) => Array.from({ length: 100 }, (_, a) => f.tirerLot(total, a)).filter(l => l.type === 'plat').length;
  assert.ok(nbPlats(12_000) < nbPlats(25_000) && nbPlats(25_000) < nbPlats(60_000));
  assert.strictEqual(f.tirerLot(5_000), null);
});

test('validité : du lendemain à J+15, une seule utilisation', () => {
  const { valableDes, expireLe } = f.periodeValidite('2026-11-30');
  assert.deepStrictEqual([valableDes, expireLe], ['2026-12-01', '2026-12-15']);
  const bon = { statut: 'actif', valableDes, expireLe, lot: { libelle: 'Un jus offert' } };
  assert.strictEqual(f.etatBon(bon, '2026-11-30').raison, 'trop-tot');
  assert.strictEqual(f.etatBon(bon, '2026-12-01').valide, true);
  assert.strictEqual(f.etatBon(bon, '2026-12-16').raison, 'expire');
  assert.strictEqual(f.etatBon({ ...bon, statut: 'utilise' }, '2026-12-05').raison, 'utilise');
  assert.strictEqual(f.etatBon(null, '2026-12-05').raison, 'inconnu');
});

test('codes : 10 caractères lisibles, normalisation de la saisie', () => {
  const c = f.genererCode();
  assert.match(c, /^[A-HJ-NP-Z2-9]{10}$/);
  assert.strictEqual(f.normaliserCode(' ab-cd 23 '), 'ABCD23');
});

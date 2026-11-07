const test = require('node:test');
const assert = require('node:assert');
const { periodeValide, chiffreAffaires, ventesParJour, depensesPourCompta } = require('../utils/integration');

const factures = [
  { date: '2026-11-02', statut: 'payee', total: 5000, modePaiement: 'especes' },
  { date: '2026-11-02', statut: 'payee', total: 3000, modePaiement: 'mobile' },
  { date: '2026-11-01', statut: 'payee', total: 2000 },                             // ancien doc sans mode
  { date: '2026-11-01', statut: 'impayee', total: 9000, modePaiement: 'especes' },  // pas encaissée
  { date: '2026-11-01', statut: 'payee', total: 7000, type: 'bon-cuisine' },        // bon CUI : pas une vente
];

test('CA : factures payées seulement, sans les bons CUI/BAR', () => {
  assert.deepStrictEqual(chiffreAffaires(factures), {
    total: 10000, nombre: 3, parMode: { especes: 7000, mobile: 3000 },
  });
});

test('ventes regroupées par jour et par mode, triées par date', () => {
  assert.deepStrictEqual(ventesParJour(factures), [
    { date: '2026-11-01', total: 2000, nombre: 1, parMode: { especes: 2000 } },
    { date: '2026-11-02', total: 8000, nombre: 2, parMode: { especes: 5000, mobile: 3000 } },
  ]);
});

test('dépenses : supprimées transmises avec leur marque', () => {
  const out = depensesPourCompta([
    { id: 'b', date: '2026-11-02', libelle: 'Gaz', categorie: 'gaz', montant: 15000, modePaiement: 'especes' },
    { id: 'a', date: '2026-11-01', libelle: 'Riz', categorie: 'marche-vivres', montant: 20000, supprimee: true },
  ]);
  assert.deepStrictEqual(out.map(d => [d.id, d.supprimee, d.modePaiement]), [['a', true, 'especes'], ['b', false, 'especes']]);
});

test('période valide', () => {
  assert.ok(periodeValide('2026-11-01', '2026-11-30'));
  assert.ok(!periodeValide('2026-11-30', '2026-11-01'));
  assert.ok(!periodeValide('2026-11', '2026-11-30'));
});

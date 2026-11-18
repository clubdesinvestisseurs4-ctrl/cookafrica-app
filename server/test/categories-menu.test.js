// La catégorie d'une ligne de facture/commande rattachée au menu vient du menu, pas de
// l'écran (FACT-1224 du 2026-11-18 : une vente de vin rangée dans « Total plats »).
const test = require('node:test');
const assert = require('node:assert');
const cache = require('../utils/cache');
const { avecCategoriesDuMenu } = require('../utils/listes');

test('la catégorie du menu remplace celle envoyée par l’écran', async () => {
  cache.set('menu:list', [
    { id: 'vin', nom: 'Château des Hauts Murasses', categorie: 'Boissons', prix: 20000 },
    { id: 'sauce', nom: 'Sauce Emeredji', categorie: 'Plats (sauce)', prix: 10000 },
  ], 60_000);

  const lignes = await avecCategoriesDuMenu([
    { menuItemId: 'vin', nom: 'Château des Hauts Murasses', prix: 10000, quantite: 1, sousTotal: 10000, categorie: '' },
    { menuItemId: 'sauce', nom: 'Sauce Emeredji', prix: 10000, quantite: 1, sousTotal: 10000, categorie: 'Boissons' },
    { menuItemId: '', nom: 'Remise fidélité', prix: -2000, quantite: 1, sousTotal: -2000, categorie: 'Remise' },
    { menuItemId: 'supprime', nom: 'Ancien plat', prix: 5000, quantite: 1, sousTotal: 5000, categorie: 'Plats' },
  ]);

  assert.deepStrictEqual(lignes.map(l => l.categorie), ['Boissons', 'Plats (sauce)', 'Remise', 'Plats']);
  assert.strictEqual(lignes[0].prix, 10000, 'le prix baissé est conservé');
  cache.delPrefix('menu:list');
});

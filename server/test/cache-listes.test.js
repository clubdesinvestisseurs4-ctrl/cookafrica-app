// Listes en cache tenues à jour à l'écriture (utils/cache.js) — sans Firestore.
const test = require('node:test');
const assert = require('node:assert');

const cache = require('../utils/cache');

test('remember : un seul chargement pour des demandes simultanées', async () => {
  let appels = 0;
  const loader = async () => { appels++; await new Promise(r => setTimeout(r, 20)); return [1]; };
  const [a, b, c] = await Promise.all([
    cache.remember('t:remember', 1000, loader),
    cache.remember('t:remember', 1000, loader),
    cache.remember('t:remember', 1000, loader),
  ]);
  assert.strictEqual(appels, 1);
  assert.deepStrictEqual([a, b, c], [[1], [1], [1]]);
  await cache.remember('t:remember', 1000, loader);
  assert.strictEqual(appels, 1); // servi par le cache
});

test('remember : un échec n\'est pas mis en cache', async () => {
  await assert.rejects(cache.remember('t:echec', 1000, async () => { throw new Error('x'); }));
  assert.deepStrictEqual(await cache.remember('t:echec', 1000, async () => 'ok'), 'ok');
});

test('patchDoc : création, modification, changement de jour, suppression', () => {
  cache.set('commandes:list:2026-11-04', [{ id: 'a', date: '2026-11-04', statut: 'en-attente' }], 60_000);
  cache.set('commandes:list:2026-11-01:2026-11-30', [{ id: 'a', date: '2026-11-04', statut: 'en-attente' }], 60_000);
  cache.set('commandes:list', [{ id: 'a', date: '2026-11-04', statut: 'en-attente' }], 60_000);
  cache.set('factures:list:2026-11-04', [], 60_000);

  cache.patchDoc('commandes', 'b', { type: 'set', data: { date: '2026-11-04', statut: 'en-preparation' } });
  assert.deepStrictEqual(cache.get('commandes:list:2026-11-04').map(c => c.id), ['b', 'a']);
  assert.deepStrictEqual(cache.get('commandes:list:2026-11-01:2026-11-30').map(c => c.id), ['b', 'a']);
  assert.deepStrictEqual(cache.get('commandes:list').map(c => c.id), ['b', 'a']);
  assert.deepStrictEqual(cache.get('factures:list:2026-11-04'), []); // autre collection intacte

  cache.patchDoc('commandes', 'a', { type: 'merge', data: { statut: 'servie' } });
  assert.strictEqual(cache.get('commandes:list:2026-11-04').find(c => c.id === 'a').statut, 'servie');
  assert.strictEqual(cache.get('commandes:list:2026-11-04').find(c => c.id === 'a').date, '2026-11-04');

  // Antidatée : sort de la liste du jour, reste dans celle du mois.
  cache.patchDoc('commandes', 'b', { type: 'merge', data: { date: '2026-11-02' } });
  assert.deepStrictEqual(cache.get('commandes:list:2026-11-04').map(c => c.id), ['a']);
  assert.deepStrictEqual(cache.get('commandes:list:2026-11-01:2026-11-30').map(c => c.id), ['b', 'a']);

  cache.patchDoc('commandes', 'a', { type: 'delete' });
  assert.deepStrictEqual(cache.get('commandes:list:2026-11-04'), []);
  assert.deepStrictEqual(cache.get('commandes:list').map(c => c.id), ['b']);
});

test('patchDoc : modification partielle d\'un document inconnu d\'une liste de période -> liste jetée', () => {
  cache.set('factures:list:2026-11-04', [], 60_000);
  cache.set('factures:list', [], 60_000);
  cache.patchDoc('factures', 'x', { type: 'merge', data: { statut: 'payee' } });
  assert.deepStrictEqual(cache.get('factures:list:2026-11-04'), []); // sans date : rien à conclure
  cache.patchDoc('factures', 'x', { type: 'merge', data: { date: '2026-11-04', statut: 'payee' } });
  assert.strictEqual(cache.get('factures:list:2026-11-04'), null); // document entier inconnu : relu
  assert.deepStrictEqual(cache.get('factures:list'), []); // liste "récents" : un vieux document n'y entre pas
});

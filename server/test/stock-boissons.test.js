const test = require('node:test');
const assert = require('node:assert');
const { validerMouvement, calculerEtat } = require('../utils/stockBoissons');

const boissons = [
  { id: 'coca', nom: 'Coca World', prix: 2000, categorie: 'Boissons' },
  { id: 'heineken', nom: 'Heineken (Bière)', prix: 2500, categorie: 'Boissons' },
];
const parId = new Map(boissons.map(b => [b.id, b]));

test('mouvement : lignes vides ignorées, quantités entières, boisson du menu obligatoire', () => {
  const ok = validerMouvement({ date: '2026-11-10', sens: 'entree', lignes: [{ menuItemId: 'coca', quantite: 24, prixAchat: 900 }, { menuItemId: 'heineken', quantite: '' }] }, parId, '2026-11-12');
  assert.deepStrictEqual(ok.data.lignes, [{ menuItemId: 'coca', nom: 'Coca World', quantite: 24, prixAchat: 900 }]);
  assert.strictEqual(ok.data.motif, 'achat');
  assert.ok(validerMouvement({ date: '2026-11-10', sens: 'sortie', lignes: [{ menuItemId: 'coca', quantite: 1.5 }] }, parId, '2026-11-12').error);
  assert.ok(validerMouvement({ date: '2026-11-10', sens: 'sortie', lignes: [{ menuItemId: 'pirate', quantite: 1 }] }, parId, '2026-11-12').error);
  assert.ok(validerMouvement({ date: '2026-11-13', sens: 'entree', lignes: [{ menuItemId: 'coca', quantite: 1 }] }, parId, '2026-11-12').error);
  assert.ok(validerMouvement({ date: '2026-11-10', sens: 'sortie', motif: 'achat', lignes: [{ menuItemId: 'coca', quantite: 1 }] }, parId, '2026-11-12').error);
  assert.ok(validerMouvement({ date: '2026-11-10', sens: 'entree', lignes: [] }, parId, '2026-11-12').error);
});

test('plus de « correction de vente » ni de comptage du frigo : seules les saisies manuelles comptent', () => {
  assert.ok(validerMouvement({ date: '2026-11-10', sens: 'reattribution', de: { menuItemId: 'coca', quantite: 1 }, vers: { menuItemId: 'heineken', quantite: 1 } }, parId, '2026-11-12').error);
  assert.ok(validerMouvement({ date: '2026-11-10', sens: 'comptage', motif: 'frigo', lignes: [{ menuItemId: 'coca', quantite: 3 }] }, parId, '2026-11-12').error);
  const c = validerMouvement({ date: '2026-11-10', sens: 'comptage', lignes: [{ menuItemId: 'coca', quantite: 0 }, { menuItemId: 'heineken', quantite: '' }] }, parId, '2026-11-12');
  assert.deepStrictEqual([c.data.motif, c.data.lignes], ['stock', [{ menuItemId: 'coca', nom: 'Coca World', quantite: 0 }]]); // 0 compté ≠ case vide
});

test('état : stock de départ, entrées, ventes saisies le soir, valeur au prix de vente', () => {
  const mouvements = [
    { date: '2026-11-01', sens: 'entree', motif: 'achat', lignes: [{ menuItemId: 'coca', quantite: 48 }, { menuItemId: 'heineken', quantite: 24 }] },
    { date: '2026-11-05', sens: 'sortie', motif: 'vente', lignes: [{ menuItemId: 'coca', quantite: 10 }] },
    { date: '2026-11-10', sens: 'entree', motif: 'achat', lignes: [{ menuItemId: 'coca', quantite: 24 }] },
    { date: '2026-11-10', sens: 'sortie', motif: 'vente', lignes: [{ menuItemId: 'coca', quantite: 6 }, { menuItemId: 'heineken', quantite: 4 }] },
    { date: '2026-11-10', sens: 'sortie', motif: 'casse', lignes: [{ menuItemId: 'heineken', quantite: 1 }] },
    { date: '2026-11-10', sens: 'sortie', motif: 'vente', supprime: true, lignes: [{ menuItemId: 'coca', quantite: 99 }] },
    // Ancienne saisie d'un type abandonné : ignorée.
    { date: '2026-11-10', sens: 'reattribution', motif: 'caisse', de: { menuItemId: 'coca', quantite: 1 }, vers: { menuItemId: 'heineken', quantite: 1 } },
  ];
  const e = calculerEtat({ boissons, mouvements, debut: '2026-11-10', fin: '2026-11-10' });
  const coca = e.lignes.find(l => l.menuItemId === 'coca');
  const hein = e.lignes.find(l => l.menuItemId === 'heineken');
  assert.deepStrictEqual([coca.stockDebut, coca.entrees, coca.sortiesVente, coca.stockFin], [38, 24, 6, 56]);
  assert.deepStrictEqual([hein.stockDebut, hein.sortiesVente, hein.sortiesAutres, hein.stockFin], [24, 4, 1, 19]);
  assert.strictEqual(e.totaux.valeurStock, 56 * 2000 + 19 * 2500);
  assert.strictEqual(e.totaux.valeurVentes, 6 * 2000 + 4 * 2500);
  assert.strictEqual(e.totaux.bouteillesEnStock, 75);
});

test('comptage du soir : fixe le stock réel, l\'écart avec le stock attendu est affiché', () => {
  const mouvements = [
    { date: '2026-11-12', sens: 'entree', motif: 'achat', lignes: [{ menuItemId: 'coca', quantite: 24 }] },
    // Saisi avant les ventes, mais le comptage reste la photo de fin de journée.
    { date: '2026-11-13', sens: 'comptage', motif: 'stock', createdAt: '2026-11-13T20:00:00Z', lignes: [{ menuItemId: 'coca', quantite: 15 }] },
    { date: '2026-11-13', sens: 'sortie', motif: 'vente', createdAt: '2026-11-13T21:00:00Z', lignes: [{ menuItemId: 'coca', quantite: 7 }] },
    { date: '2026-11-14', sens: 'sortie', motif: 'vente', lignes: [{ menuItemId: 'coca', quantite: 5 }] },
  ];
  const j13 = calculerEtat({ boissons, mouvements, debut: '2026-11-13', fin: '2026-11-13' }).lignes.find(l => l.menuItemId === 'coca');
  // attendu 24 − 7 = 17, compté 15 → 2 manquantes
  assert.deepStrictEqual([j13.stockDebut, j13.sortiesVente, j13.ecart, j13.stockFin, j13.dernierComptage], [24, 7, 2, 15, '2026-11-13']);
  const j14 = calculerEtat({ boissons, mouvements, debut: '2026-11-14', fin: '2026-11-14' });
  const c14 = j14.lignes.find(l => l.menuItemId === 'coca');
  assert.deepStrictEqual([c14.stockDebut, c14.ecart, c14.stockFin], [15, 0, 10]);
  // Sans aucun mouvement dans la période, le stock de départ reste celui de la veille.
  const j20 = calculerEtat({ boissons, mouvements, debut: '2026-11-20', fin: '2026-11-20' }).lignes.find(l => l.menuItemId === 'coca');
  assert.deepStrictEqual([j20.stockDebut, j20.stockFin], [10, 10]);
});

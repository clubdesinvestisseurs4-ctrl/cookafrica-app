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

test('état : stock de départ, entrées, sorties, valeur au prix de vente, contrôle avec la caisse', () => {
  const mouvements = [
    { date: '2026-11-01', sens: 'entree', motif: 'achat', lignes: [{ menuItemId: 'coca', quantite: 48 }, { menuItemId: 'heineken', quantite: 24 }] },
    { date: '2026-11-05', sens: 'sortie', motif: 'vente', lignes: [{ menuItemId: 'coca', quantite: 10 }] },
    { date: '2026-11-10', sens: 'entree', motif: 'achat', lignes: [{ menuItemId: 'coca', quantite: 24 }] },
    { date: '2026-11-10', sens: 'sortie', motif: 'vente', lignes: [{ menuItemId: 'coca', quantite: 6 }, { menuItemId: 'heineken', quantite: 4 }] },
    { date: '2026-11-10', sens: 'sortie', motif: 'casse', lignes: [{ menuItemId: 'heineken', quantite: 1 }] },
    { date: '2026-11-10', sens: 'sortie', motif: 'vente', supprime: true, lignes: [{ menuItemId: 'coca', quantite: 99 }] },
  ];
  const factures = [
    { date: '2026-11-10', statut: 'payee', items: [{ menuItemId: 'coca', nom: 'Coca World', categorie: 'Boissons', quantite: 5, sousTotal: 10000 }, { nom: 'Buffet', categorie: 'Buffet', quantite: 1, sousTotal: 15000 }] },
    { date: '2026-11-10', statut: 'payee', items: [{ nom: 'Heineken (Bière)', categorie: 'Boissons', quantite: 4, sousTotal: 10000 }] }, // sans menuItemId : rapproché par le nom
    { date: '2026-11-10', statut: 'partielle', items: [{ menuItemId: 'coca', categorie: 'Boissons', quantite: 3, sousTotal: 6000 }] }, // non payée : ignorée
  ];
  const e = calculerEtat({ boissons, mouvements, factures, debut: '2026-11-10', fin: '2026-11-10' });
  const coca = e.lignes.find(l => l.menuItemId === 'coca');
  const hein = e.lignes.find(l => l.menuItemId === 'heineken');
  assert.deepStrictEqual([coca.stockDebut, coca.entrees, coca.sorties, coca.stockFin], [38, 24, 6, 56]);
  assert.deepStrictEqual([coca.sortiesVente, coca.vendusCaisse, coca.ecart], [6, 5, 1]); // 1 Coca sorti mais pas facturé
  assert.deepStrictEqual([hein.stockFin, hein.sortiesAutres, hein.vendusCaisse, hein.ecart], [19, 1, 4, 0]);
  assert.strictEqual(e.totaux.valeurStock, 56 * 2000 + 19 * 2500);
  assert.strictEqual(e.totaux.montantCaisse, 20000); // = total boissons du tableau de bord
  assert.strictEqual(e.totaux.articlesEnEcart, 1);
});

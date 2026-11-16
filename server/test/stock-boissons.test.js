const test = require('node:test');
const assert = require('node:assert');
const { validerMouvement, debutLectureFactures, calculerEtat } = require('../utils/stockBoissons');

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
  assert.deepStrictEqual([coca.sortiesVente, coca.vendusCaisse], [6, 5]);
  // Frigo suivi depuis le 1er mouvement : 10 sortis le 05 (pas de vente connue) + 6 − 5 vendus le 10.
  assert.strictEqual(coca.frigo, 11);
  assert.deepStrictEqual([hein.stockFin, hein.sortiesAutres, hein.vendusCaisse, hein.frigo], [19, 1, 4, 0]);
  assert.strictEqual(e.totaux.valeurStock, (56 + 11) * 2000 + 19 * 2500); // réserve + frigo
  assert.strictEqual(e.totaux.montantCaisse, 20000); // = total boissons du tableau de bord
});

const eau = [
  { id: 'c33', nom: 'Celeste 0.33 L', prix: 500, categorie: 'Boissons' },
  { id: 'c50', nom: 'Celeste 0.5 L', prix: 1000, categorie: 'Boissons' },
];
const eauParId = new Map(eau.map(b => [b.id, b]));
const vente = (date, id, nom, q, pu) => ({ date, statut: 'payee', items: [{ menuItemId: id, nom, categorie: 'Boissons', quantite: q, sousTotal: q * pu }] });

test('frigo : une sortie n\'est pas une vente, les bouteilles restent au frigo jusqu\'à leur vente', () => {
  const mouvements = [
    { date: '2026-11-12', sens: 'entree', motif: 'achat', lignes: [{ menuItemId: 'c50', quantite: 24 }] },
    { date: '2026-11-12', sens: 'sortie', motif: 'vente', lignes: [{ menuItemId: 'c50', quantite: 10 }] },
    { date: '2026-11-14', sens: 'entree', motif: 'retour', lignes: [{ menuItemId: 'c50', quantite: 2 }] }, // retour à la réserve
  ];
  const factures = [vente('2026-11-12', 'c50', 'Celeste 0.5 L', 3, 1000), vente('2026-11-13', 'c50', 'Celeste 0.5 L', 4, 1000)];
  const j13 = calculerEtat({ boissons: eau, mouvements, factures, debut: '2026-11-13', fin: '2026-11-13' }).lignes.find(l => l.menuItemId === 'c50');
  assert.deepStrictEqual([j13.stockFin, j13.frigo, j13.vendusCaisse, j13.sortiesVente], [14, 3, 4, 0]); // vendu le 13 ce qui est sorti le 12
  const j14 = calculerEtat({ boissons: eau, mouvements, factures, debut: '2026-11-14', fin: '2026-11-14' }).lignes.find(l => l.menuItemId === 'c50');
  assert.deepStrictEqual([j14.stockFin, j14.frigo], [16, 1]);
});

test('comptage du frigo : fixe la quantité réelle, l\'écart devient « manquants »', () => {
  const ok = validerMouvement({ date: '2026-11-13', sens: 'comptage', lignes: [{ menuItemId: 'c50', quantite: 0 }, { menuItemId: 'c33', quantite: '' }] }, eauParId, '2026-11-16');
  assert.deepStrictEqual(ok.data.lignes, [{ menuItemId: 'c50', nom: 'Celeste 0.5 L', quantite: 0 }]); // 0 compté ≠ case vide
  const mouvements = [
    { date: '2026-11-12', sens: 'sortie', motif: 'vente', lignes: [{ menuItemId: 'c50', quantite: 10 }] },
    { date: '2026-11-13', sens: 'comptage', motif: 'frigo', lignes: [{ menuItemId: 'c50', quantite: 4 }] },
  ];
  const factures = [vente('2026-11-13', 'c50', 'Celeste 0.5 L', 4, 1000), vente('2026-11-14', 'c50', 'Celeste 0.5 L', 1, 1000)];
  const e = calculerEtat({ boissons: eau, mouvements, factures, debut: '2026-11-13', fin: '2026-11-14' });
  const c50 = e.lignes.find(l => l.menuItemId === 'c50');
  assert.deepStrictEqual([c50.manquants, c50.frigo, c50.dernierComptage], [2, 3, '2026-11-13']); // attendu 6, compté 4
  assert.strictEqual(e.totaux.valeurManquants, 2000);
  // Factures à lire : depuis le lendemain du comptage, pas depuis le 12.
  assert.strictEqual(debutLectureFactures(mouvements, '2026-11-16', '2026-11-16'), '2026-11-14');
  assert.strictEqual(debutLectureFactures(mouvements.slice(0, 1), '2026-11-16', '2026-11-16'), '2026-11-12');
});

test('réattribution : 1 « Celeste 0.5 L » tapée en caisse = 2 bouteilles de 0.33 L servies', () => {
  const r = validerMouvement({ date: '2026-11-14', sens: 'reattribution', de: { menuItemId: 'c50', quantite: 1 }, vers: { menuItemId: 'c33', quantite: 2 } }, eauParId, '2026-11-16');
  assert.deepStrictEqual([r.data.motif, r.data.de.nom, r.data.vers.quantite], ['caisse', 'Celeste 0.5 L', 2]);
  assert.ok(validerMouvement({ date: '2026-11-14', sens: 'reattribution', de: { menuItemId: 'c50', quantite: 1 }, vers: { menuItemId: 'c50', quantite: 2 } }, eauParId, '2026-11-16').error);
  const mouvements = [
    { date: '2026-11-14', sens: 'entree', motif: 'achat', lignes: [{ menuItemId: 'c33', quantite: 12 }] },
    { date: '2026-11-14', sens: 'sortie', motif: 'vente', lignes: [{ menuItemId: 'c33', quantite: 2 }] },
    { date: '2026-11-14', ...r.data },
  ];
  const factures = [vente('2026-11-14', 'c50', 'Celeste 0.5 L', 1, 1000)];
  const e = calculerEtat({ boissons: eau, mouvements, factures, debut: '2026-11-14', fin: '2026-11-14' });
  const c33 = e.lignes.find(l => l.menuItemId === 'c33'), c50 = e.lignes.find(l => l.menuItemId === 'c50');
  assert.deepStrictEqual([c33.vendusCaisse, c33.reattribues, c33.frigo, c33.stockFin], [2, 2, 0, 10]);
  assert.deepStrictEqual([c50.vendusCaisse, c50.reattribues, c50.frigo], [0, -1, 0]);
  assert.strictEqual(e.totaux.montantCaisse, 1000); // l'argent encaissé ne change pas
});

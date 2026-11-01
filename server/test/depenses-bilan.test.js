// Dépenses (validation, historique) et bilan financier — logique pure, sans Firestore.
const test = require('node:test');
const assert = require('node:assert');

const { validateDepense, entreeHistorique } = require('../utils/depenses');
const { computeBilan, lundiDe } = require('../utils/bilan');

const VALIDE = { date: '2026-10-30', libelle: 'Marché Adjamé', categorie: 'marche-vivres', montant: 25000, modePaiement: 'especes' };

test('dépense valide -> champs normalisés, note vide par défaut', () => {
  const { data, error } = validateDepense({ ...VALIDE, libelle: '  Marché Adjamé ', montant: '25000', extra: 'ignoré' });
  assert.strictEqual(error, undefined);
  assert.deepStrictEqual(data, { ...VALIDE, note: '' });
});

test('dépense : champs obligatoires et valeurs aberrantes rejetés', () => {
  assert.match(validateDepense({ ...VALIDE, montant: 0 }).error, /positif/);
  assert.match(validateDepense({ ...VALIDE, montant: -5 }).error, /positif/);
  assert.match(validateDepense({ ...VALIDE, montant: 'abc' }).error, /positif/);
  assert.match(validateDepense({ ...VALIDE, libelle: '   ' }).error, /libellé/);
  assert.match(validateDepense({ ...VALIDE, categorie: 'casino' }).error, /Catégorie/);
  assert.match(validateDepense({ ...VALIDE, modePaiement: 'bitcoin' }).error, /paiement/);
  assert.match(validateDepense({ ...VALIDE, date: '30/10/2026' }).error, /Date/);
  assert.match(validateDepense({ ...VALIDE, date: '2026-11-02' }, { today: '2026-11-01' }).error, /futur/);
});

test('modification partielle : seuls les champs envoyés, au moins un requis', () => {
  assert.deepStrictEqual(validateDepense({ montant: 30000 }, { partiel: true }).data, { montant: 30000 });
  assert.match(validateDepense({}, { partiel: true }).error, /Aucune/);
});

test('historique de modification : garde les anciennes valeurs des seuls champs changés', () => {
  const e = entreeHistorique('modification', { username: 'admin', nom: 'Admin' }, new Date('2026-11-01T10:00:00Z'),
    VALIDE, { montant: 30000, libelle: VALIDE.libelle });
  assert.deepStrictEqual(e.modifies, { montant: { avant: 25000, apres: 30000 } });
  assert.strictEqual(e.par, 'admin');
});

test('semaines du lundi au dimanche', () => {
  assert.strictEqual(lundiDe('2026-11-01'), '2026-10-26'); // dimanche -> lundi précédent
  assert.strictEqual(lundiDe('2026-10-26'), '2026-10-26');
});

test('bilan : entrées = factures payées seulement, dépenses supprimées exclues, détail par jour', () => {
  const commandes = [
    { id: 'c1', modeConsommation: 'sur-place' },
    { id: 'c2', modeConsommation: 'a-emporter', modeEstime: true },
  ];
  const factures = [
    { commandeId: 'c1', type: 'facture', statut: 'payee', date: '2026-10-30', total: 5000,
      items: [{ nom: 'Attiéké', categorie: 'Plats (sauce)', quantite: 2, sousTotal: 4000 }, { nom: 'Coca', categorie: 'Boissons', quantite: 1, sousTotal: 1000 }] },
    { commandeId: 'c2', statut: 'payee', date: '2026-10-31', total: 3000,
      items: [{ nom: 'Attiéké', categorie: 'Plats (sauce)', quantite: 1, sousTotal: 3000 }] },
    { commandeId: 'c3', type: 'facture', statut: 'partielle', reste: 2000, date: '2026-10-31', total: 2000, items: [] },
    { commandeId: 'c4', type: 'bon-cuisine', statut: 'payee', date: '2026-10-31', total: 999, items: [] },
  ];
  const depenses = [
    { date: '2026-10-30', montant: 1500, categorie: 'gaz' },
    { date: '2026-10-31', montant: 4000, categorie: 'marche-vivres' },
    { date: '2026-10-31', montant: 9999, categorie: 'autre', supprimee: true },
  ];

  const b = computeBilan({ factures, commandes, depenses, debut: '2026-10-29', fin: '2026-10-31' });
  assert.strictEqual(b.entrees, 8000);
  assert.strictEqual(b.depenses, 5500);
  assert.strictEqual(b.resultat, 2500);
  assert.strictEqual(b.nonEncaisse, 2000);
  assert.deepStrictEqual(b.depensesParCategorie, { gaz: 1500, 'marche-vivres': 4000 });

  assert.deepStrictEqual(b.parJour.map(j => [j.date, j.entrees, j.depenses, j.resultat]), [
    ['2026-10-29', 0, 0, 0], // jour sans activité : présent, à zéro
    ['2026-10-30', 5000, 1500, 3500],
    ['2026-10-31', 3000, 4000, -1000], // perte du jour
  ]);

  assert.deepStrictEqual(b.parMode['sur-place'], { commandes: 1, platsQte: 2, boissonsQte: 1, ca: 5000, commandesEstimees: 0 });
  assert.deepStrictEqual(b.parMode['a-emporter'], { commandes: 1, platsQte: 1, boissonsQte: 0, ca: 3000, commandesEstimees: 1 });

  const attieke = b.detailArticles.find(a => a.nom === 'Attiéké');
  assert.deepStrictEqual(attieke['sur-place'], { quantite: 2, total: 4000 });
  assert.deepStrictEqual(attieke['a-emporter'], { quantite: 1, total: 3000 });
  assert.strictEqual(b.parSemaine.length, 1);
  assert.strictEqual(b.parMois[0].periode, '2026-10');
});

test('bilan : facture dont la commande est introuvable ou non classée -> "non classé", jamais devinée', () => {
  const b = computeBilan({
    factures: [{ commandeId: 'inconnue', statut: 'payee', date: '2026-10-30', total: 1000, items: [] }],
    commandes: [], depenses: [], debut: '2026-10-30', fin: '2026-10-30',
  });
  assert.strictEqual(b.parMode['non-classe'].ca, 1000);
  assert.strictEqual(b.parMode['sur-place'].ca, 0);
});

// Suppléments (riz, boisson redemandés après facturation) — logique pure, sans Firestore.
const test = require('node:test');
const assert = require('node:assert');

const {
  estSupplementAuto, resolveSupplement, supplementApresFacture, champsRattachement,
} = require('../utils/commandes');
const { computeBilan } = require('../utils/bilan');

const RIZ = { nom: 'Riz', categorie: 'Accompagnement', quantite: 1, sousTotal: 1000 };
const COCA = { nom: 'Coca World', categorie: 'Boissons', quantite: 1, sousTotal: 2000 };
const PLAT = { nom: 'Sauce graine', categorie: 'Plats (sauce)', quantite: 1, sousTotal: 10000 };
const BUFFET = { nom: 'Buffet standard', categorie: 'Buffet', quantite: 1, sousTotal: 15000 };

test('supplément proposé d\'office : que des accompagnements et/ou des boissons', () => {
  assert.strictEqual(estSupplementAuto([RIZ]), true);
  assert.strictEqual(estSupplementAuto([COCA]), true);
  assert.strictEqual(estSupplementAuto([RIZ, COCA]), true);
  assert.strictEqual(estSupplementAuto([RIZ, PLAT]), false);
  assert.strictEqual(estSupplementAuto([BUFFET]), false);
  assert.strictEqual(estSupplementAuto([{ ...COCA, nom: 'Buffet boissons' }]), false);
  assert.strictEqual(estSupplementAuto([]), false);
});

test('case cochée / décochée à la main l\'emporte sur la règle', () => {
  assert.deepStrictEqual(resolveSupplement(undefined, [COCA]), { supplement: true, supplementSource: 'auto' });
  assert.deepStrictEqual(resolveSupplement(false, [COCA]), { supplement: false, supplementSource: 'manuel' });
  assert.deepStrictEqual(resolveSupplement(true, [PLAT]), { supplement: true, supplementSource: 'manuel' });
  assert.deepStrictEqual(resolveSupplement(true, [RIZ]), { supplement: true, supplementSource: 'auto' });
});

test('un plat ajouté sur la facture fait d\'un supplément auto une vraie commande', () => {
  const cmd = { supplement: true, supplementSource: 'auto', items: [COCA] };
  assert.deepStrictEqual(supplementApresFacture(cmd, [COCA, PLAT]), { supplement: false });
  assert.strictEqual(supplementApresFacture(cmd, [COCA]), null);
  assert.strictEqual(supplementApresFacture({ ...cmd, supplementSource: 'manuel' }, [PLAT]), null);
  assert.strictEqual(supplementApresFacture({ ...cmd, commandeParentId: 'p1' }, [PLAT]), null);
});

test('rattaché : prend le mode de la commande d\'origine', () => {
  const r = champsRattachement({ id: 'p1', numero: 'CMD-0100', modeConsommation: 'sur-place' });
  assert.deepStrictEqual(r, {
    supplement: true, supplementSource: 'manuel', commandeParentId: 'p1', commandeParentNumero: 'CMD-0100',
    modeConsommation: 'sur-place', modeSource: 'parent', modeEstime: false,
  });
});

test('bilan : un supplément compte dans le CA et les articles, pas comme une commande', () => {
  const commandes = [
    { id: 'p1', modeConsommation: 'sur-place', supplement: false, items: [PLAT] },
    { id: 's1', modeConsommation: 'sur-place', supplement: true, commandeParentId: 'p1', items: [COCA] },
    { id: 'old', modeConsommation: 'a-emporter', items: [RIZ] }, // ancienne : règle appliquée
  ];
  const factures = [
    { commandeId: 'p1', statut: 'payee', date: '2026-11-02', total: 10000, items: [PLAT] },
    { commandeId: 's1', statut: 'payee', date: '2026-11-02', total: 2000, items: [COCA] },
    { commandeId: 'old', statut: 'payee', date: '2026-11-02', total: 1000, items: [RIZ] },
  ];
  const b = computeBilan({ factures, commandes, depenses: [], debut: '2026-11-02', fin: '2026-11-02' });
  assert.deepStrictEqual(b.parMode['sur-place'], { commandes: 1, supplements: 1, platsQte: 1, boissonsQte: 1, ca: 12000, commandesEstimees: 0 });
  assert.strictEqual(b.parMode['a-emporter'].commandes, 0);
  assert.strictEqual(b.parMode['a-emporter'].supplements, 1);
  assert.strictEqual(b.entrees, 13000);
});

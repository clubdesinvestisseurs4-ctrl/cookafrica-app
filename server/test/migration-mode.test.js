// Reprise des anciennes commandes (classement rétroactif + incohérences) et suivi du mode
// quand la facture ajoute des articles.
const test = require('node:test');
const assert = require('node:assert');

const { classerCommande, detecterAnomalies, apercuMigration } = require('../utils/migrationMode');
const { modeApresFacture } = require('../utils/commandes');

const PLAT = { nom: 'Garba', categorie: 'Plats (sauce)', prix: 1000, quantite: 1, sousTotal: 1000 };
const BOISSON = { nom: 'Bissap', categorie: 'Boissons', prix: 500, quantite: 1, sousTotal: 500 };
const ROLES = new Map([['serv1', 'serveur'], ['caisse1', 'caissiere'], ['vieux', 'receptionniste'], ['cuisine', 'cuisiniere']]);

test('ancienne commande serveur -> sur place ; caissière sans boisson -> à emporter', () => {
  assert.deepStrictEqual(classerCommande({ createdBy: 'serv1', statut: 'servie', items: [PLAT] }, ROLES),
    { action: 'classer', mode: 'sur-place', role: 'serveur' });
  assert.deepStrictEqual(classerCommande({ createdBy: 'caisse1', statut: 'servie', items: [PLAT] }, ROLES),
    { action: 'classer', mode: 'a-emporter', role: 'caissiere' });
});

test('boisson ajoutée sur la facture -> sur place, avec la raison notée', () => {
  const d = classerCommande({ createdBy: 'caisse1', statut: 'servie', items: [PLAT] }, ROLES, [PLAT, BOISSON]);
  assert.strictEqual(d.mode, 'sur-place');
  assert.match(d.note, /facture/);
});

test('déjà classée -> gardée ; annulée -> ignorée ; ancien nom de rôle -> renommé', () => {
  assert.strictEqual(classerCommande({ modeConsommation: 'a-emporter', items: [PLAT, BOISSON] }, ROLES).action, 'garder');
  assert.strictEqual(classerCommande({ createdBy: 'serv1', statut: 'annulee', items: [PLAT] }, ROLES).action, 'ignorer');
  assert.strictEqual(classerCommande({ createdBy: 'vieux', statut: 'servie', items: [PLAT] }, ROLES).role, 'caissiere');
});

test('auteur inconnu ou rôle inattendu -> classé quand même mais signalé ambigu', () => {
  const inconnu = classerCommande({ createdBy: 'supprime', statut: 'servie', items: [PLAT, BOISSON] }, ROLES);
  assert.strictEqual(inconnu.mode, 'sur-place');
  assert.match(inconnu.ambigu, /auteur inconnu/);
  assert.match(classerCommande({ createdBy: 'cuisine', statut: 'servie', items: [PLAT] }, ROLES).ambigu, /cuisiniere/);
});

test('incohérences : signalées par type, réservations non comptées comme anomalies', () => {
  const commandes = [
    { id: 'a', numero: 'CMD-1', date: '2026-10-01', statut: 'servie', total: 1500, items: [PLAT, BOISSON] },
    { id: 'b', numero: 'CMD-2', date: '2026-10-01', statut: 'servie', total: 999, items: [PLAT] },
    { id: 'c', numero: 'CMD-2', date: '2026-10-02', statut: 'servie', total: 1000, items: [PLAT] },
  ];
  const factures = [
    { numero: 'F-1', commandeId: 'a', date: '2026-10-01', total: 1200, items: [PLAT, BOISSON] },
    { numero: 'F-2', commandeId: 'b', date: '2026-10-02', total: 999, items: [PLAT] },
    { numero: 'F-3', commandeId: '', reservationId: 'r1', total: 50000 },
    { numero: 'F-4', commandeId: '', total: 100 },
  ];
  const types = detecterAnomalies(commandes, factures).map(a => a.type).sort();
  assert.deepStrictEqual(types, [
    'date-facture-differente', 'facture-sans-commande', 'numero-en-double',
    'prix-ajuste-a-la-caisse', 'servie-sans-facture', 'total-commande-incoherent',
  ]);
});

test('aperçu : compteurs cohérents', () => {
  const { resume } = apercuMigration(
    [
      { id: '1', createdBy: 'serv1', statut: 'servie', items: [PLAT], total: 1000, date: '2026-10-01' },
      { id: '2', createdBy: 'caisse1', statut: 'servie', items: [PLAT], total: 1000, date: '2026-10-01' },
      { id: '3', createdBy: 'caisse1', statut: 'annulee', items: [PLAT], total: 1000, date: '2026-10-01' },
      { id: '4', modeConsommation: 'sur-place', statut: 'servie', items: [PLAT], total: 1000, date: '2026-10-01' },
    ],
    [], [{ username: 'serv1', role: 'serveur' }, { username: 'caisse1', role: 'caissiere' }],
  );
  assert.strictEqual(resume.aClasser, 2);
  assert.strictEqual(resume['sur-place'], 1);
  assert.strictEqual(resume['a-emporter'], 1);
  assert.strictEqual(resume.ignorees, 1);
  assert.strictEqual(resume.dejaClassees, 1);
});

test('nouvelle commande caisse : boisson ajoutée sur la facture -> passe "sur place" si mode auto', () => {
  const cmd = { createdByRole: 'caissiere', modeSource: 'auto', modeConsommation: 'a-emporter', items: [PLAT] };
  assert.deepStrictEqual(modeApresFacture(cmd, [PLAT, BOISSON]), { modeConsommation: 'sur-place' });
  assert.strictEqual(modeApresFacture({ ...cmd, modeSource: 'manuel' }, [PLAT, BOISSON]), null); // choix humain respecté
  assert.strictEqual(modeApresFacture({ ...cmd, createdByRole: undefined }, [PLAT, BOISSON]), null); // ancienne commande
  assert.strictEqual(modeApresFacture(cmd, [PLAT]), null); // rien ne change
});

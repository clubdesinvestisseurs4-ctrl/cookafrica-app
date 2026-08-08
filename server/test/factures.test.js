// Tests de la génération de facture (pure logique métier) — utilisent un faux
// `db` Firestore en mémoire, comme security.test.js : pas de connexion réelle.
const test = require('node:test');
const assert = require('node:assert');

const { getNextNumeroFacture, createFactureFromCommande } = require('../utils/factures');

// Faux Firestore minimal : supporte collection().orderBy/where/limit().get()
// et collection().add(), assez pour ce que utils/factures.js utilise réellement.
function makeFakeDb(seedFactures = []) {
  const factures = [...seedFactures];

  function query(filters = []) {
    return {
      orderBy: () => query(filters),
      limit: () => query(filters),
      where: (field, op, value) => query([...filters, { field, op, value }]),
      get: async () => {
        const docs = factures.filter((d) => filters.every((f) => d[f.field] === f.value));
        return { empty: docs.length === 0, size: docs.length, docs: docs.map((d) => ({ id: d.id, data: () => d })) };
      },
    };
  }

  return {
    collection(name) {
      if (name !== 'factures') throw new Error('collection inattendue dans ce test : ' + name);
      return {
        ...query(),
        add: async (data) => {
          const id = `fact_${factures.length + 1}`;
          factures.push({ id, ...data });
          return { id };
        },
      };
    },
  };
}

const COMMANDE_TEST = {
  numero: 'CMD-0012',
  items: [{ menuItemId: 'm1', nom: 'Attiéké Poisson', prix: 2000, quantite: 2, sousTotal: 4000, categorie: 'Plats' }],
  tableNumero: '5',
  note: '',
  createdByNom: 'Jean (serveur)',
  createdBy: 'jean',
};

test('getNextNumeroFacture — repart à FACT-0001 si la base est vide', async () => {
  const numero = await getNextNumeroFacture(makeFakeDb());
  assert.strictEqual(numero, 'FACT-0001');
});

test('getNextNumeroFacture — incrémente après le plus grand numéro FACT existant', async () => {
  const db = makeFakeDb([
    { id: 'a', numero: 'FACT-0003', createdAt: '2026-01-01' },
    { id: 'b', numero: 'FACT-0001', createdAt: '2026-01-02' },
  ]);
  assert.strictEqual(await getNextNumeroFacture(db), 'FACT-0004');
});

test('getNextNumeroFacture — ignore les numéros non-FACT (bons cuisine/bar)', async () => {
  const db = makeFakeDb([
    { id: 'a', numero: 'CUI-CMD-0099', createdAt: '2026-01-01' },
    { id: 'b', numero: 'FACT-0002', createdAt: '2026-01-02' },
  ]);
  assert.strictEqual(await getNextNumeroFacture(db), 'FACT-0003');
});

test('createFactureFromCommande — génère une facture partielle avec le bon total', async () => {
  const db = makeFakeDb();
  const { facture, error } = await createFactureFromCommande(db, COMMANDE_TEST, 'cmd_1', { createdBy: 'jean' });
  assert.strictEqual(error, undefined);
  assert.strictEqual(facture.numero, 'FACT-0001');
  assert.strictEqual(facture.commandeId, 'cmd_1');
  assert.strictEqual(facture.total, 4000);
  assert.strictEqual(facture.reste, 4000);
  assert.strictEqual(facture.statut, 'partielle');
  assert.strictEqual(facture.serveurNom, 'Jean (serveur)');
});

test('createFactureFromCommande — caissiereName vide par défaut (auto-génération à l\'envoi)', async () => {
  const { facture } = await createFactureFromCommande(makeFakeDb(), COMMANDE_TEST, 'cmd_1', { createdBy: 'jean' });
  assert.strictEqual(facture.caissiereName, '');
});

test('createFactureFromCommande — caissiereName renseigné si fourni (génération manuelle)', async () => {
  const { facture } = await createFactureFromCommande(makeFakeDb(), COMMANDE_TEST, 'cmd_1', {
    createdBy: 'admin', caissiereName: 'Awa (caissière)',
  });
  assert.strictEqual(facture.caissiereName, 'Awa (caissière)');
});

test('createFactureFromCommande — refuse une commande sans articles', async () => {
  const { error } = await createFactureFromCommande(makeFakeDb(), { ...COMMANDE_TEST, items: [] }, 'cmd_1', {});
  assert.strictEqual(error, 'La commande est vide');
});

test('createFactureFromCommande — refuse si une facture existe déjà pour cette commande', async () => {
  const db = makeFakeDb([{ id: 'existing', commandeId: 'cmd_1', numero: 'FACT-0001' }]);
  const { error } = await createFactureFromCommande(db, COMMANDE_TEST, 'cmd_1', {});
  assert.strictEqual(error, 'Une facture existe déjà pour cette commande');
});
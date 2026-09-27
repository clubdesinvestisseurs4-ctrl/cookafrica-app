// Tests de la génération de facture (pure logique métier) — utilisent un faux
// `db` Firestore en mémoire, comme security.test.js : pas de connexion réelle.
const test = require('node:test');
const assert = require('node:assert');

const { getNextNumeroFacture, createFactureFromCommande } = require('../utils/factures');

// Faux Firestore minimal : supporte collection().orderBy/where/limit().get()
// et collection().add() pour "factures", plus collection('counters').doc(id)
// (get/create/update/set) et runTransaction(), pour le compteur de numérotation
// dans utils/factures.js. Pas de vraie isolation transactionnelle : suffisant
// pour ces tests séquentiels, pas conçu pour simuler de la concurrence réelle.
function makeFakeDb(seedFactures = []) {
  const factures = [...seedFactures];
  const counters = {};

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

  function makeCounterRef(id) {
    return {
      id,
      async get() {
        return {
          exists: Object.prototype.hasOwnProperty.call(counters, id),
          data: () => counters[id],
        };
      },
      async create(data) {
        if (Object.prototype.hasOwnProperty.call(counters, id)) throw new Error('ALREADY_EXISTS');
        counters[id] = { ...data };
      },
      async update(data) {
        counters[id] = { ...(counters[id] || {}), ...data };
      },
      async set(data, opts) {
        counters[id] = opts && opts.merge ? { ...(counters[id] || {}), ...data } : { ...data };
      },
    };
  }

  return {
    collection(name) {
      if (name === 'counters') return { doc: (id) => makeCounterRef(id) };
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
    async runTransaction(fn) {
      const tx = {
        get: (ref) => ref.get(),
        update: (ref, data) => { ref.update(data); },
        set: (ref, data, opts) => { ref.set(data, opts); },
      };
      return fn(tx);
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

test('getNextNumeroFacture — appels successifs incrémentent depuis le compteur, pas un rescan', async () => {
  const db = makeFakeDb([{ id: 'a', numero: 'FACT-0003', createdAt: '2026-01-01' }]);
  assert.strictEqual(await getNextNumeroFacture(db), 'FACT-0004');
  // Le compteur vaut maintenant 4 en mémoire ; même si aucune facture FACT-0004
  // n'a réellement été ajoutée à la collection (le scan, lui, verrait toujours
  // 3 comme maximum), l'appel suivant doit repartir de la valeur du compteur.
  assert.strictEqual(await getNextNumeroFacture(db), 'FACT-0005');
});

test('getNextNumeroFacture — n\'initialise le compteur qu\'une seule fois (pas de rescan après)', async () => {
  const db = makeFakeDb([{ id: 'a', numero: 'FACT-0003', createdAt: '2026-01-01' }]);
  await getNextNumeroFacture(db); // initialise le compteur à 3, retourne FACT-0004
  const counterDoc = await db.collection('counters').doc('factures').get();
  assert.strictEqual(counterDoc.data().value, 4);
  await getNextNumeroFacture(db);
  const counterDocAfter = await db.collection('counters').doc('factures').get();
  assert.strictEqual(counterDocAfter.data().value, 5);
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
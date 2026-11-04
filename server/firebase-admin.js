const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldPath, FieldValue, Query, DocumentReference } = require('firebase-admin/firestore');

// Render : clé de service explicite via variables d'env.
// Cloud Run : pas de clé — utilise les Application Default Credentials
// du compte de service attaché à l'instance (rôle Firestore accordé côté IAM).
const app = getApps().length
  ? getApps()[0]
  : initializeApp(
      process.env.FIREBASE_PRIVATE_KEY
        ? {
            credential: cert({
              projectId:   process.env.FIREBASE_PROJECT_ID,
              clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
              privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            }),
          }
        : undefined
    );

// FIRESTORE_DATABASE_ID sélectionne la base nommée du site (ex. 'dubai') — absent ou
// '(default)' pour le site d'origine, qui garde la base par défaut du projet.
const db = getFirestore(app, process.env.FIRESTORE_DATABASE_ID || '(default)');
db.settings({ ignoreUndefinedProperties: true });

// ─── Surveillance du quota gratuit de lectures (50 000/jour, voir routes/quota.js) ──
// Intercepte Query#get et DocumentReference#get UNE SEULE FOIS ici plutôt que
// d'instrumenter chaque route : compte le nombre réel de documents lus (snap.size),
// pas juste le nombre d'appels — une requête qui renvoie 40 documents compte pour 40
// lectures Firestore, pas 1. Le compteur en mémoire est propre à ce process (Render et
// Lambda ont chacun le leur, et Render redémarre à froid) donc il est reversé au plus
// une fois par minute dans un document partagé via un incrément atomique — un write de
// plus par minute au pire, négligeable face au quota d'écriture (20 000/jour), pour
// obtenir un total fiable tous processus confondus.
let _pendingReads = 0;
let _pendingParRoute = {};
let _flushTimer = null;
const QUOTA_FLUSH_MS = Number(process.env.QUOTA_FLUSH_MS) || 60_000; // surchargé en test seulement

// Route à l'origine de chaque lecture (ex. "GET /api/commandes"), posée par le middleware
// `suivreLecturesParRoute` (server.js) : le détail par route est reversé avec le total,
// pour savoir QUELLE vue consomme le quota au lieu de le deviner (demande du 2026-11-04).
const { AsyncLocalStorage } = require('async_hooks');
const contexteLecture = new AsyncLocalStorage();

function _flushReadCount() {
  _flushTimer = null;
  const delta = _pendingReads;
  const parRoute = _pendingParRoute;
  _pendingReads = 0;
  _pendingParRoute = {};
  if (delta === 0) return;
  const day = new Date().toISOString().split('T')[0];
  const routes = Object.fromEntries(Object.entries(parRoute).map(([r, n]) => [r, FieldValue.increment(n)]));
  db.collection('_meta').doc(`quotaLectures-${day}`)
    .set({ count: FieldValue.increment(delta), day, routes }, { merge: true })
    .catch(() => {}); // surveillance best-effort : ne doit jamais faire échouer une requête réelle
}

function _countReads(n) {
  if (n === 0) return;
  _pendingReads += n;
  const route = contexteLecture.getStore()?.route || 'hors-requete';
  _pendingParRoute[route] = (_pendingParRoute[route] || 0) + n;
  if (!_flushTimer) _flushTimer = setTimeout(_flushReadCount, QUOTA_FLUSH_MS);
}

// Identifiants et dates remplacés pour regrouper ("GET /api/commandes/:id"). Les clés de
// la map Firestore ne peuvent contenir ni '.', ni '/', ni '~', ni '*', ni '[' ou ']'.
function libelleRoute(req) {
  const chemin = (req.originalUrl || req.url || '').split('?')[0]
    .replace(/\/[A-Za-z0-9_-]{15,}(?=\/|$)/g, '/:id')
    .replace(/\/\d{4}-\d{2}-\d{2}(?=\/|$)/g, '/:date');
  return `${req.method} ${chemin}`.replace(/[./~*[\]]/g, '_');
}

function suivreLecturesParRoute(req, res, next) {
  contexteLecture.run({ route: libelleRoute(req) }, next);
}

const _originalQueryGet = Query.prototype.get;
Query.prototype.get = function (...args) {
  return _originalQueryGet.apply(this, args).then((snap) => { _countReads(snap.size); return snap; });
};

const _originalDocGet = DocumentReference.prototype.get;
DocumentReference.prototype.get = function (...args) {
  return _originalDocGet.apply(this, args).then((snap) => { _countReads(1); return snap; });
};

// ─── Listes en cache tenues à jour à chaque écriture (voir utils/cache.js#patchDoc) ──
// Branché ici, une seule fois, sur toutes les écritures commandes/factures : aucune route
// ne peut l'oublier. Les écritures en lot (batch, transaction) ne passent pas par là — les
// rares routes qui en font sur ces collections vident leurs listes elles-mêmes.
const LISTES_SUIVIES = new Set(['commandes', 'factures']);

function collectionSuivie(ref) {
  const parent = ref.parent;
  return parent && !parent.parent && LISTES_SUIVIES.has(parent.id) ? parent.id : null;
}

// Champs écrits tels qu'ils seront relus. null si on ne peut pas le savoir sans relire
// (chemin "a.b", FieldValue.increment/serverTimestamp/…) : la liste est alors vidée.
function champsLisibles(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue; // ignoreUndefinedProperties : Firestore n'écrit rien
    if (k.includes('.') || v instanceof FieldValue) return null;
    out[k] = v;
  }
  return out;
}

function patcherApres(ref, change) {
  const col = collectionSuivie(ref);
  if (!col) return;
  const cache = require('./utils/cache');
  if (change.type !== 'delete' && !change.data) cache.delPrefix(`${col}:list`);
  else cache.patchDoc(col, ref.id, change);
}

const _originalUpdate = DocumentReference.prototype.update;
DocumentReference.prototype.update = function (data, ...rest) {
  return _originalUpdate.call(this, data, ...rest).then((r) => {
    patcherApres(this, { type: 'merge', data: rest.length ? null : champsLisibles(data) });
    return r;
  });
};

const _originalSet = DocumentReference.prototype.set;
DocumentReference.prototype.set = function (data, options) {
  return _originalSet.call(this, data, options).then((r) => {
    const fusion = options && (options.merge || options.mergeFields);
    patcherApres(this, { type: fusion ? 'merge' : 'set', data: champsLisibles(data) });
    return r;
  });
};

const _originalCreate = DocumentReference.prototype.create;
DocumentReference.prototype.create = function (data) {
  return _originalCreate.call(this, data).then((r) => {
    patcherApres(this, { type: 'set', data: champsLisibles(data) });
    return r;
  });
};

const _originalDelete = DocumentReference.prototype.delete;
DocumentReference.prototype.delete = function (...args) {
  return _originalDelete.apply(this, args).then((r) => {
    patcherApres(this, { type: 'delete' });
    return r;
  });
};

module.exports = { db, FieldPath, suivreLecturesParRoute };

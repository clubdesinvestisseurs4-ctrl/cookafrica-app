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
let _flushTimer = null;
const QUOTA_FLUSH_MS = 60_000;

function _flushReadCount() {
  _flushTimer = null;
  const delta = _pendingReads;
  _pendingReads = 0;
  if (delta === 0) return;
  const day = new Date().toISOString().split('T')[0];
  db.collection('_meta').doc(`quotaLectures-${day}`)
    .set({ count: FieldValue.increment(delta), day }, { merge: true })
    .catch(() => {}); // surveillance best-effort : ne doit jamais faire échouer une requête réelle
}

function _countReads(n) {
  _pendingReads += n;
  if (!_flushTimer) _flushTimer = setTimeout(_flushReadCount, QUOTA_FLUSH_MS);
}

const _originalQueryGet = Query.prototype.get;
Query.prototype.get = function (...args) {
  return _originalQueryGet.apply(this, args).then((snap) => { _countReads(snap.size); return snap; });
};

const _originalDocGet = DocumentReference.prototype.get;
DocumentReference.prototype.get = function (...args) {
  return _originalDocGet.apply(this, args).then((snap) => { _countReads(1); return snap; });
};

module.exports = { db, FieldPath };

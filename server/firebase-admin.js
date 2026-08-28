const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldPath } = require('firebase-admin/firestore');

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

module.exports = { db, FieldPath };

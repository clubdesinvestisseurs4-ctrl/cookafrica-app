const admin = require('firebase-admin');

if (!admin.apps.length) {
  // Render : clé de service explicite via variables d'env.
  // Cloud Run : pas de clé — utilise les Application Default Credentials
  // du compte de service attaché à l'instance (rôle Firestore accordé côté IAM).
  admin.initializeApp(
    process.env.FIREBASE_PRIVATE_KEY
      ? {
          credential: admin.credential.cert({
            projectId:   process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
          }),
        }
      : undefined
  );
}

const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

module.exports = { db, admin };

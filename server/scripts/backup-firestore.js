// Sauvegarde complète de la base Firestore en JSON, une fichier par collection.
//
//   node scripts/backup-firestore.js --count            # taille de chaque collection, sans rien exporter
//   node scripts/backup-firestore.js --out <dossier>    # export complet
//
// Identifiants : mêmes variables que le serveur (FIREBASE_PROJECT_ID / CLIENT_EMAIL /
// PRIVATE_KEY, FIRESTORE_DATABASE_ID), lues depuis le .env ou depuis le fichier passé
// dans ENV_FILE — à garder HORS du repo.
//
// Coût : chaque document exporté compte pour 1 lecture sur le quota gratuit (50 000/jour,
// voir routes/quota.js). --count, lui, passe par des agrégations count() : ~1 lecture par
// tranche de 1 000 documents. Toujours lancer --count d'abord, et l'export hors service.
require('dotenv').config(process.env.ENV_FILE ? { path: process.env.ENV_FILE } : {});
const fs = require('fs');
const path = require('path');
const { Timestamp, GeoPoint, DocumentReference } = require('firebase-admin/firestore');
const { db } = require('../firebase-admin');

const PAGE_SIZE = 500;

// Les données de l'app sont quasi toutes en chaînes ISO, mais on garde une trace typée
// des quelques types Firestore natifs pour qu'une restauration puisse les reconstruire.
function serialize(value) {
  if (value instanceof Timestamp) return { __type: 'timestamp', value: value.toDate().toISOString() };
  if (value instanceof GeoPoint) return { __type: 'geopoint', latitude: value.latitude, longitude: value.longitude };
  if (value instanceof DocumentReference) return { __type: 'ref', path: value.path };
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serialize(v)]));
  }
  return value;
}

async function countAll(collections) {
  let total = 0;
  for (const col of collections) {
    const n = (await col.count().get()).data().count;
    total += n;
    console.log(`${col.id.padEnd(20)} ${n}`);
  }
  console.log(`${'TOTAL'.padEnd(20)} ${total}`);
}

async function exportAll(collections, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = { exportedAt: new Date().toISOString(), projectId: process.env.FIREBASE_PROJECT_ID,
    database: process.env.FIRESTORE_DATABASE_ID || '(default)', collections: {} };

  for (const col of collections) {
    const docs = [];
    let last = null;
    // Pagination par ID de document : pas d'index requis, et un export interrompu
    // ne charge jamais toute une grosse collection en une seule requête.
    for (;;) {
      let q = col.orderBy('__name__').limit(PAGE_SIZE);
      if (last) q = q.startAfter(last);
      const snap = await q.get();
      snap.docs.forEach(d => docs.push({ id: d.id, data: serialize(d.data()) }));
      if (snap.size < PAGE_SIZE) break;
      last = snap.docs[snap.docs.length - 1];
    }
    fs.writeFileSync(path.join(outDir, `${col.id}.json`), JSON.stringify(docs, null, 2));
    manifest.collections[col.id] = docs.length;
    console.log(`${col.id.padEnd(20)} ${docs.length} document(s)`);
  }

  fs.writeFileSync(path.join(outDir, '_manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Sauvegarde écrite dans ${outDir}`);
}

async function main() {
  const args = process.argv.slice(2);
  const collections = await db.listCollections();
  if (args.includes('--count')) return countAll(collections);

  const outIdx = args.indexOf('--out');
  if (outIdx === -1 || !args[outIdx + 1]) {
    console.error('Usage : --count, ou --out <dossier>');
    process.exitCode = 1;
    return;
  }
  await exportAll(collections, args[outIdx + 1]);
}

main()
  .then(() => console.log('(fermeture dans ~1 min : enregistrement du compteur de lectures, voir firebase-admin.js)'))
  .catch(err => { console.error(err); process.exitCode = 1; });

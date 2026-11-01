// Classement rétroactif sur place / à emporter des commandes d'avant le 2026-11-01.
//
//   node scripts/migrate-mode-consommation.js --from-backup <dossier>   # aperçu hors ligne (0 lecture)
//   node scripts/migrate-mode-consommation.js                           # aperçu sur la base réelle
//   node scripts/migrate-mode-consommation.js --apply                   # écrit le classement
//   ... --report <fichier.json>                                         # détail complet (anomalies, cas ambigus)
//
// Sans --apply, rien n'est écrit. Les commandes classées ici sont marquées
// `modeEstime: true` / `modeSource: 'estime'` pour les distinguer des nouvelles ; celles
// déjà classées (règle du 2026-10-14) et les annulées ne sont pas touchées. Les anomalies
// sont seulement signalées, jamais corrigées. Faire une sauvegarde (backup-firestore.js) avant --apply.
require('dotenv').config(process.env.ENV_FILE ? { path: process.env.ENV_FILE } : {});
const fs = require('fs');
const path = require('path');
const { apercuMigration } = require('../utils/migrationMode');

const BATCH_MAX = 400; // < 500, limite Firestore par batch

function lireBackup(dir) {
  const lire = (nom) => JSON.parse(fs.readFileSync(path.join(dir, `${nom}.json`), 'utf8'))
    .map(d => ({ id: d.id, ...d.data }));
  return { commandes: lire('commandes'), factures: lire('factures'), utilisateurs: lire('utilisateurs') };
}

async function lireBase(db) {
  const lire = async (nom) => (await db.collection(nom).get()).docs.map(d => ({ id: d.id, ...d.data() }));
  const [commandes, factures, utilisateurs] = await Promise.all([lire('commandes'), lire('factures'), lire('utilisateurs')]);
  return { commandes, factures, utilisateurs };
}

function afficher({ resume, decisions, anomalies }) {
  console.log('\n=== APERÇU DU CLASSEMENT ===');
  console.log(`Commandes en base              : ${resume.total}`);
  console.log(`Déjà classées (inchangées)     : ${resume.dejaClassees}`);
  console.log(`Annulées (ignorées)            : ${resume.ignorees}`);
  console.log(`À classer                      : ${resume.aClasser}`);
  console.log(`  -> Sur place                 : ${resume['sur-place']}`);
  console.log(`  -> À emporter                : ${resume['a-emporter']}`);
  console.log(`  dont cas ambigus             : ${resume.ambigus}`);
  console.log(`  dont décidés par la facture  : ${resume.decidesParFacture} (boisson/buffet ajouté à l'encaissement)`);
  console.log('\nRépartition par rôle du créateur :');
  for (const [role, m] of Object.entries(resume.parRole)) {
    console.log(`  ${role.padEnd(18)} sur place ${String(m['sur-place']).padStart(4)}   à emporter ${String(m['a-emporter']).padStart(4)}`);
  }

  const ambigus = decisions.filter(d => d.ambigu);
  if (ambigus.length) {
    console.log('\nCas ambigus :');
    ambigus.slice(0, 30).forEach(d => console.log(`  ${d.commande.numero} (${d.commande.date}) -> ${d.mode} : ${d.ambigu}`));
    if (ambigus.length > 30) console.log(`  … et ${ambigus.length - 30} autre(s), voir --report`);
  }

  const parType = {};
  anomalies.forEach(a => { (parType[a.type] ||= []).push(a); });
  console.log(`\n=== INCOHÉRENCES DÉTECTÉES (${anomalies.length}) — signalées, non corrigées ===`);
  for (const [type, liste] of Object.entries(parType).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${type.padEnd(30)} ${liste.length}`);
    liste.slice(0, 3).forEach(a => console.log(`      ex. ${a.ref} : ${a.detail}`));
  }
}

async function appliquer(db, decisions) {
  const aEcrire = decisions.filter(d => d.action === 'classer');
  const now = new Date().toISOString();
  let ecrites = 0;
  for (let i = 0; i < aEcrire.length; i += BATCH_MAX) {
    const batch = db.batch();
    for (const d of aEcrire.slice(i, i + BATCH_MAX)) {
      batch.update(db.collection('commandes').doc(d.commande.id), {
        modeConsommation: d.mode,
        modeSource: 'estime',
        modeEstime: true,
        modeEstimeAt: now,
        ...(d.ambigu || d.note ? { modeEstimeNote: [d.ambigu, d.note].filter(Boolean).join(' ; ') } : {}),
        ...(d.role && !d.commande.createdByRole ? { createdByRole: d.role } : {}),
      });
    }
    await batch.commit();
    ecrites += Math.min(BATCH_MAX, aEcrire.length - i);
    console.log(`  ${ecrites}/${aEcrire.length} commande(s) classée(s)`);
  }
  return ecrites;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (nom) => { const i = args.indexOf(nom); return i === -1 ? null : args[i + 1]; };
  const backupDir = opt('--from-backup');
  const apply = args.includes('--apply');
  if (apply && backupDir) throw new Error('--apply écrit dans la base réelle : incompatible avec --from-backup');

  let db = null;
  let donnees;
  if (backupDir) {
    donnees = lireBackup(backupDir);
    console.log(`Source : sauvegarde ${backupDir}`);
  } else {
    ({ db } = require('../firebase-admin'));
    donnees = await lireBase(db);
    const projet = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT;
    console.log(`Source : base Firestore ${projet} (${process.env.FIRESTORE_DATABASE_ID || '(default)'})`
      + (process.env.FIRESTORE_EMULATOR_HOST ? ' — ÉMULATEUR' : ''));
  }

  const apercu = apercuMigration(donnees.commandes, donnees.factures, donnees.utilisateurs);
  afficher(apercu);

  const reportPath = opt('--report');
  if (reportPath) {
    fs.writeFileSync(reportPath, JSON.stringify({
      genereLe: new Date().toISOString(),
      resume: apercu.resume,
      ambigus: apercu.decisions.filter(d => d.ambigu).map(d => ({ numero: d.commande.numero, date: d.commande.date, mode: d.mode, raison: d.ambigu })),
      classement: apercu.decisions.filter(d => d.action === 'classer')
        .map(d => ({ numero: d.commande.numero, date: d.commande.date, role: d.role, mode: d.mode, ...(d.note ? { note: d.note } : {}) })),
      anomalies: apercu.anomalies,
    }, null, 2));
    console.log(`\nRapport détaillé : ${reportPath}`);
  }

  if (!apply) {
    console.log('\nAperçu seulement : rien n\'a été écrit. Relancer avec --apply pour appliquer.');
    return;
  }
  console.log('\nApplication du classement…');
  const n = await appliquer(db, apercu.decisions);
  console.log(`Terminé : ${n} commande(s) classée(s) et marquée(s) "estimé".`);
}

main()
  .then(() => {
    // firebase-admin.js reverse le compteur de lectures (quota) au plus une fois par minute :
    // on laisse le process se terminer seul pour que ces lectures soient bien comptées.
    if (!process.argv.includes('--from-backup')) console.log('(fermeture dans ~1 min : enregistrement du compteur de lectures)');
  })
  .catch(err => { console.error(err.message || err); process.exitCode = 1; });

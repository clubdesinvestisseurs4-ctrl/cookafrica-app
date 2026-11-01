// Reprise des anciennes commandes (avant le 2026-11-01) : classement rétroactif sur place /
// à emporter avec les mêmes règles qu'à la création (utils/commandes.js#modeParDefaut), et
// relevé des incohérences des données historiques. Logique pure — le script
// scripts/migrate-mode-consommation.js s'occupe des lectures/écritures Firestore.
const { modeParDefaut } = require('./commandes');

// Mêmes renommages de rôles qu'à la connexion (middleware/auth.js).
const ROLE_MIGRATION = { directeur: 'admin', receptionniste: 'caissiere', cuisinier: 'cuisiniere' };
const ROLES_CREATEURS = ['admin', 'serveur', 'caissiere', 'caissier-en-ligne', 'client-web'];

function roleDuCreateur(commande, roleParUsername) {
  if (commande.createdByRole) return commande.createdByRole;
  if (commande.commandeClient || commande.createdBy === 'client-web') return 'client-web';
  const brut = roleParUsername.get(commande.createdBy);
  return brut ? (ROLE_MIGRATION[brut] || brut) : null;
}

// Décide du mode d'UNE commande ancienne. Retourne :
//   { action: 'garder' }  — déjà classée (règle du 2026-10-14 sur les commandes en ligne)
//   { action: 'ignorer', raison } — annulée : ne compte dans aucune statistique
//   { action: 'classer', mode, role, ambigu? } — à écrire, avec la raison si le cas est douteux
// `articlesFactures` : articles de la (des) facture(s) de la commande. La caissière ajoute
// parfois une boisson au moment d'encaisser (22 cas sur l'historique au 2026-11-01) : la
// facture reflète ce qui a vraiment été consommé, donc la règle "boisson" regarde les deux.
function classerCommande(commande, roleParUsername, articlesFactures = []) {
  if (commande.modeConsommation) return { action: 'garder' };
  if (commande.statut === 'annulee') return { action: 'ignorer', raison: 'annulée' };

  const items = [...(commande.items || []), ...articlesFactures];
  const role = roleDuCreateur(commande, roleParUsername);
  const viaFacture = role !== 'serveur' && modeParDefaut(role, commande.items) !== modeParDefaut(role, items);
  const info = viaFacture ? { note: 'boisson/buffet ajouté sur la facture à l\'encaissement' } : {};

  if (!role) {
    // Auteur supprimé ou inconnu : on applique la règle "articles" (celle de tous les rôles
    // sauf serveur) mais on le signale — c'est une estimation plus fragile que les autres.
    return { action: 'classer', mode: modeParDefaut(null, items), role: null, ...info,
      ambigu: `auteur inconnu (${commande.createdBy || 'vide'}) : règle boisson/buffet appliquée` };
  }
  if (!ROLES_CREATEURS.includes(role)) {
    return { action: 'classer', mode: modeParDefaut(role, items), role, ...info,
      ambigu: `créée par un compte "${role}", qui n'est pas censé prendre de commandes` };
  }
  return { action: 'classer', mode: modeParDefaut(role, items), role, ...info };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Incohérences des données historiques — signalées, jamais corrigées par la migration.
function detecterAnomalies(commandes, factures) {
  const anomalies = [];
  const ajouter = (type, ref, detail) => anomalies.push({ type, ref, detail });

  const facturesParCommande = new Map();
  for (const f of factures) {
    if (f.type && f.type !== 'facture') continue;
    // Acompte/solde de réservation (routes/reservations.js) : pas de commande, c'est normal.
    if (!f.commandeId && f.reservationId) continue;
    if (!f.commandeId) { ajouter('facture-sans-commande', f.numero, 'aucune commande ni réservation liée'); continue; }
    if (!facturesParCommande.has(f.commandeId)) facturesParCommande.set(f.commandeId, []);
    facturesParCommande.get(f.commandeId).push(f);
  }
  const commandesById = new Map(commandes.map(c => [c.id, c]));
  for (const [commandeId, fs] of facturesParCommande) {
    if (!commandesById.has(commandeId)) {
      fs.forEach(f => ajouter('facture-commande-introuvable', f.numero, `commande ${commandeId} absente`));
    }
  }

  const numeros = new Map();
  for (const c of commandes) {
    const ref = c.numero || c.id;
    numeros.set(c.numero, (numeros.get(c.numero) || 0) + 1);

    if (!DATE_RE.test(c.date || '')) ajouter('date-invalide', ref, `date = ${JSON.stringify(c.date)}`);
    const items = c.items || [];
    if (items.length === 0) ajouter('commande-vide', ref, 'aucun article');

    items.forEach(i => {
      if (!i.categorie) ajouter('article-sans-categorie', ref, i.nom);
      if (!(i.quantite > 0) || !Number.isInteger(i.quantite)) ajouter('quantite-invalide', ref, `${i.nom} : ${i.quantite}`);
      if (!(i.prix > 0)) ajouter('prix-nul-ou-negatif', ref, `${i.nom} : ${i.prix}`);
      if (i.prix * i.quantite !== i.sousTotal) ajouter('sous-total-incoherent', ref, `${i.nom} : ${i.prix} × ${i.quantite} ≠ ${i.sousTotal}`);
    });
    const somme = items.reduce((s, i) => s + (i.sousTotal || 0), 0);
    if (somme !== c.total) ajouter('total-commande-incoherent', ref, `somme des articles ${somme} ≠ total ${c.total}`);

    const fs = facturesParCommande.get(c.id) || [];
    if (c.statut === 'servie' && fs.length === 0) ajouter('servie-sans-facture', ref, 'commande servie mais aucune facture');
    if (c.statut === 'annulee' && fs.length > 0) ajouter('annulee-avec-facture', ref, fs.map(f => f.numero).join(', '));
    if (fs.length > 1) ajouter('plusieurs-factures', ref, fs.map(f => f.numero).join(', '));
    for (const f of fs) {
      if (f.date !== c.date) ajouter('date-facture-differente', ref, `${f.numero} datée ${f.date}, commande ${c.date}`);
      // Pas forcément une erreur : la caissière peut ajuster prix et articles au paiement.
      // On distingue un simple prix ajusté (mêmes articles) d'articles ajoutés/retirés.
      if (f.total !== c.total) {
        const cle = (items) => (items || []).map(i => `${i.nom}×${i.quantite}`).sort().join('|');
        const type = cle(f.items) === cle(c.items) ? 'prix-ajuste-a-la-caisse' : 'articles-modifies-a-la-caisse';
        ajouter(type, ref, `${f.numero} : ${f.total} vs commande ${c.total}`);
      }
    }
    if (c.source === 'en-ligne' && c.createdByRole === 'serveur') {
      ajouter('canal-incoherent', ref, 'commande en ligne créée par un serveur');
    }
  }
  for (const [numero, n] of numeros) if (n > 1) ajouter('numero-en-double', numero, `${n} commandes`);

  return anomalies;
}

// Aperçu complet : décisions par commande + compteurs + anomalies.
function apercuMigration(commandes, factures, utilisateurs) {
  const roleParUsername = new Map(utilisateurs.map(u => [u.username, u.role]));
  const articlesFactures = new Map();
  for (const f of factures) {
    if (!f.commandeId || (f.type && f.type !== 'facture')) continue;
    articlesFactures.set(f.commandeId, [...(articlesFactures.get(f.commandeId) || []), ...(f.items || [])]);
  }
  const decisions = commandes.map(c => ({
    commande: c, ...classerCommande(c, roleParUsername, articlesFactures.get(c.id)),
  }));

  const resume = { total: commandes.length, dejaClassees: 0, ignorees: 0, aClasser: 0,
    'sur-place': 0, 'a-emporter': 0, ambigus: 0, decidesParFacture: 0, parRole: {} };
  for (const d of decisions) {
    if (d.action === 'garder') resume.dejaClassees++;
    else if (d.action === 'ignorer') resume.ignorees++;
    else {
      resume.aClasser++;
      resume[d.mode]++;
      if (d.ambigu) resume.ambigus++;
      if (d.note) resume.decidesParFacture++;
      const r = d.role || 'inconnu';
      resume.parRole[r] ||= { 'sur-place': 0, 'a-emporter': 0 };
      resume.parRole[r][d.mode]++;
    }
  }
  return { resume, decisions, anomalies: detecterAnomalies(commandes, factures) };
}

module.exports = { classerCommande, detecterAnomalies, apercuMigration, roleDuCreateur };

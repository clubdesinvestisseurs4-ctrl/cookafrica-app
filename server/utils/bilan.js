// Bilan financier (entrées − dépenses = résultat) et ventilation sur place / à emporter.
// Logique pure, partagée par /api/stats/bilan et /api/stats/rapport, testable sans Firestore.

const MODES = ['sur-place', 'a-emporter'];
const NON_CLASSE = 'non-classe';

// Les bons cuisine/bar (CUI-, BAR-) vivaient dans la même collection que les factures :
// seule une vraie facture (type 'facture', ou ancien document sans type) est une vente.
function estVente(f) {
  return !f.type || f.type === 'facture';
}

// "Entrées" du bilan = argent réellement encaissé : factures payées uniquement, à la date
// de la commande (même règle de datation que le reste de l'app, voir utils/factures.js).
function estEncaissee(f) {
  return estVente(f) && f.statut === 'payee';
}

function estBoisson(item) {
  return item.categorie === 'Boissons'; // même critère que le dashboard (routes/stats.js)
}

// Mode d'une facture = celui de sa commande. Une facture sans commande retrouvée (ou une
// commande jamais classée) part dans "non classé" plutôt que d'être devinée ici.
function modeDeFacture(f, commandesById) {
  const c = f.commandeId ? commandesById.get(f.commandeId) : null;
  return MODES.includes(c?.modeConsommation) ? c.modeConsommation : NON_CLASSE;
}

function compteurVide() {
  return { commandes: 0, platsQte: 0, boissonsQte: 0, ca: 0, commandesEstimees: 0 };
}

// Ventilation par mode : nombre de commandes, plats (hors boissons) et boissons vendus,
// chiffre d'affaires — plus le détail par article (combien emportés, combien sur place).
function statsParMode(factures, commandesById) {
  const parMode = { 'sur-place': compteurVide(), 'a-emporter': compteurVide(), [NON_CLASSE]: compteurVide() };
  const detail = new Map();

  for (const f of factures) {
    const mode = modeDeFacture(f, commandesById);
    const m = parMode[mode];
    m.commandes += 1;
    m.ca += f.total || 0;
    if (commandesById.get(f.commandeId)?.modeEstime) m.commandesEstimees += 1;

    for (const item of f.items || []) {
      const qte = item.quantite || 0;
      if (estBoisson(item)) m.boissonsQte += qte; else m.platsQte += qte;

      const cle = `${item.categorie || 'Autre'}||${item.nom}`;
      if (!detail.has(cle)) {
        detail.set(cle, {
          nom: item.nom, categorie: item.categorie || 'Autre',
          'sur-place': { quantite: 0, total: 0 }, 'a-emporter': { quantite: 0, total: 0 },
          [NON_CLASSE]: { quantite: 0, total: 0 },
        });
      }
      const d = detail.get(cle)[mode];
      d.quantite += qte;
      d.total += item.sousTotal || 0;
    }
  }

  const detailArticles = [...detail.values()].sort((a, b) => {
    const qa = a['sur-place'].quantite + a['a-emporter'].quantite + a[NON_CLASSE].quantite;
    const qb = b['sur-place'].quantite + b['a-emporter'].quantite + b[NON_CLASSE].quantite;
    return qb - qa || a.nom.localeCompare(b.nom, 'fr');
  });
  return { parMode, detailArticles };
}

// Lundi de la semaine d'une date AAAA-MM-JJ (semaines du lundi au dimanche).
function lundiDe(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const decalage = (d.getUTCDay() + 6) % 7; // 0 = lundi
  d.setUTCDate(d.getUTCDate() - decalage);
  return d.toISOString().slice(0, 10);
}

function clePeriode(date, granularite) {
  if (granularite === 'semaine') return lundiDe(date);
  if (granularite === 'mois') return date.slice(0, 7);
  return date;
}

function joursEntre(debut, fin) {
  const jours = [];
  for (let d = new Date(`${debut}T00:00:00Z`); d <= new Date(`${fin}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    jours.push(d.toISOString().slice(0, 10));
  }
  return jours;
}

const MAX_JOURS_PRE_REMPLIS = 400;

// Séries jour / semaine / mois : entrées, dépenses, résultat et CA par mode. Quand la
// période est bornée (et raisonnable), chaque jour y figure, même à 0 — un jour sans
// vente ni dépense doit se voir dans le détail, pas disparaître.
function series(factures, depenses, commandesById, debut, fin) {
  const parJour = new Map();
  const ligne = (date) => {
    if (!parJour.has(date)) {
      parJour.set(date, { date, entrees: 0, depenses: 0, resultat: 0, 'sur-place': 0, 'a-emporter': 0, [NON_CLASSE]: 0 });
    }
    return parJour.get(date);
  };

  if (debut && fin && debut <= fin) {
    const jours = joursEntre(debut, fin);
    if (jours.length <= MAX_JOURS_PRE_REMPLIS) jours.forEach(ligne);
  }
  for (const f of factures) {
    const l = ligne(f.date);
    l.entrees += f.total || 0;
    l[modeDeFacture(f, commandesById)] += f.total || 0;
  }
  for (const dep of depenses) ligne(dep.date).depenses += dep.montant || 0;

  const jours = [...parJour.values()].sort((a, b) => a.date.localeCompare(b.date));
  jours.forEach(l => { l.resultat = l.entrees - l.depenses; });

  const regrouper = (granularite) => {
    const groupes = new Map();
    for (const l of jours) {
      const cle = clePeriode(l.date, granularite);
      if (!groupes.has(cle)) {
        groupes.set(cle, { periode: cle, entrees: 0, depenses: 0, resultat: 0, 'sur-place': 0, 'a-emporter': 0, [NON_CLASSE]: 0 });
      }
      const g = groupes.get(cle);
      for (const k of ['entrees', 'depenses', 'resultat', 'sur-place', 'a-emporter', NON_CLASSE]) g[k] += l[k];
    }
    return [...groupes.values()];
  };

  return { parJour: jours, parSemaine: regrouper('semaine'), parMois: regrouper('mois') };
}

// Bilan complet d'une période. `factures`, `commandes` et `depenses` sont les documents
// bruts de la période ; le filtrage (ventes payées, dépenses non supprimées) se fait ici.
function computeBilan({ factures, commandes, depenses, debut, fin }) {
  const encaissees = factures.filter(estEncaissee);
  const depensesActives = depenses.filter(d => !d.supprimee);
  const commandesById = new Map(commandes.map(c => [c.id, c]));

  const entrees = encaissees.reduce((s, f) => s + (f.total || 0), 0);
  const totalDepenses = depensesActives.reduce((s, d) => s + (d.montant || 0), 0);

  const depensesParCategorie = {};
  depensesActives.forEach(d => {
    depensesParCategorie[d.categorie] = (depensesParCategorie[d.categorie] || 0) + (d.montant || 0);
  });

  return {
    debut: debut || null,
    fin: fin || null,
    entrees,
    depenses: totalDepenses,
    resultat: entrees - totalDepenses,
    nbVentes: encaissees.length,
    nbDepenses: depensesActives.length,
    // Factures émises mais pas encore payées sur la période : exclues des entrées, mais
    // affichées pour qu'un "résultat" faible ne cache pas un simple retard d'encaissement.
    nonEncaisse: factures.filter(f => estVente(f) && f.statut !== 'payee').reduce((s, f) => s + (f.reste ?? f.total ?? 0), 0),
    depensesParCategorie,
    ...statsParMode(encaissees, commandesById),
    ...series(encaissees, depensesActives, commandesById, debut, fin),
  };
}

module.exports = {
  MODES, NON_CLASSE, estVente, estEncaissee, modeDeFacture, statsParMode, series, lundiDe, computeBilan,
};

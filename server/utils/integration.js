// Données transmises à ERP-Compta. Logique pure (testable sans Firestore) : mêmes règles
// que le bilan de l'app (utils/bilan.js) — seule une vraie facture payée est une recette,
// jamais un bon cuisine/bar (CUI-/BAR-), pour que la compta et l'app disent le même chiffre.

const { estEncaissee } = require('./bilan');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function periodeValide(debut, fin) {
  return DATE_RE.test(debut || '') && DATE_RE.test(fin || '') && debut <= fin;
}

// Total encaissé sur la période et ventilation par mode de paiement ("Audit Flash").
function chiffreAffaires(factures) {
  const payees = factures.filter(estEncaissee);
  const parMode = {};
  let total = 0;
  for (const f of payees) {
    const mode = f.modePaiement || 'especes';
    parMode[mode] = (parMode[mode] || 0) + (f.total || 0);
    total += f.total || 0;
  }
  return { total, nombre: payees.length, parMode };
}

// Recettes encaissées regroupées par jour puis par mode de paiement : une écriture de
// ventes par jour côté ERP (pratique habituelle du journal de caisse d'un restaurant).
function ventesParJour(factures) {
  const jours = new Map();
  for (const f of factures.filter(estEncaissee)) {
    const total = f.total || 0;
    if (!total || !f.date) continue;
    const j = jours.get(f.date) || { date: f.date, total: 0, nombre: 0, parMode: {} };
    const mode = f.modePaiement || 'especes';
    j.parMode[mode] = (j.parMode[mode] || 0) + total;
    j.total += total;
    j.nombre += 1;
    jours.set(f.date, j);
  }
  return [...jours.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// Dépenses de la période, y compris supprimées (marquées) : l'ERP doit savoir qu'une
// dépense déjà passée en écriture a été annulée dans l'app pour proposer l'extourne.
function depensesPourCompta(depenses) {
  return depenses
    .map(d => ({
      id: d.id,
      date: d.date,
      libelle: d.libelle,
      categorie: d.categorie,
      montant: d.montant || 0,
      modePaiement: d.modePaiement || 'especes',
      supprimee: !!d.supprimee,
      modifieeLe: d.updatedAt || d.createdAt || null,
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

module.exports = { periodeValide, chiffreAffaires, ventesParJour, depensesPourCompta };

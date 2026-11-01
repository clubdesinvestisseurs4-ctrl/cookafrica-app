// Dépenses quotidiennes du restaurant (admin uniquement, voir routes/depenses.js).
// Logique pure : validation et historique, testables sans Firestore.

// Clés stables en base, libellés traduits côté client (i18n.js, "depenses.cat_*").
// "achat-boissons" est séparé de "marche-vivres" (demande du 2026-11-01) pour que le
// bilan montre ce que coûtent les boissons à part.
const CATEGORIES_DEPENSES = [
  'marche-vivres', 'achat-boissons', 'gaz', 'transport',
  'electricite-eau', 'salaires', 'entretien-materiel', 'autre',
];
const MODES_PAIEMENT_DEPENSE = ['especes', 'mobile', 'carte', 'virement'];
const CHAMPS_MODIFIABLES = ['date', 'libelle', 'categorie', 'montant', 'modePaiement', 'note'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LIBELLE_MAX = 120;
const NOTE_MAX = 500;
// Garde-fou contre une faute de frappe (un zéro de trop) plutôt qu'une vraie limite métier.
const MONTANT_MAX = 100_000_000;

// Valide un corps de requête. `partiel` (modification) n'exige que les champs présents.
// Retourne { error } ou { data } avec uniquement des champs connus et normalisés.
function validateDepense(body, { partiel = false, today } = {}) {
  const data = {};
  const has = (k) => body[k] !== undefined;

  if (!partiel || has('date')) {
    if (!DATE_RE.test(body.date || '')) return { error: 'Date invalide (format attendu AAAA-MM-JJ)' };
    if (today && body.date > today) return { error: 'La date ne peut pas être dans le futur' };
    data.date = body.date;
  }
  if (!partiel || has('libelle')) {
    const libelle = String(body.libelle || '').trim();
    if (!libelle) return { error: 'Le libellé est requis' };
    if (libelle.length > LIBELLE_MAX) return { error: `Libellé trop long (${LIBELLE_MAX} caractères max)` };
    data.libelle = libelle;
  }
  if (!partiel || has('categorie')) {
    if (!CATEGORIES_DEPENSES.includes(body.categorie)) return { error: 'Catégorie invalide' };
    data.categorie = body.categorie;
  }
  if (!partiel || has('montant')) {
    const montant = Number(body.montant);
    if (!Number.isFinite(montant) || montant <= 0) return { error: 'Le montant doit être un nombre positif' };
    if (montant > MONTANT_MAX) return { error: 'Montant anormalement élevé, vérifiez la saisie' };
    data.montant = Math.round(montant);
  }
  if (!partiel || has('modePaiement')) {
    if (!MODES_PAIEMENT_DEPENSE.includes(body.modePaiement)) return { error: 'Mode de paiement invalide' };
    data.modePaiement = body.modePaiement;
  }
  if (!partiel || has('note')) {
    const note = String(body.note || '').trim();
    if (note.length > NOTE_MAX) return { error: `Note trop longue (${NOTE_MAX} caractères max)` };
    data.note = note;
  }
  if (partiel && Object.keys(data).length === 0) return { error: 'Aucune modification fournie' };
  return { data };
}

// Entrée d'historique : qui, quand, quoi, et les valeurs AVANT changement (seulement les
// champs réellement modifiés) — permet de retrouver un montant corrigé ou supprimé.
function entreeHistorique(action, user, now, avant = {}, apres = {}) {
  const modifies = {};
  for (const k of CHAMPS_MODIFIABLES) {
    if (k in apres && apres[k] !== avant[k]) modifies[k] = { avant: avant[k] ?? null, apres: apres[k] };
  }
  return {
    action,
    par: user.username,
    parNom: user.nom || user.username,
    at: now.toISOString(),
    ...(action === 'modification' ? { modifies } : {}),
  };
}

module.exports = {
  CATEGORIES_DEPENSES, MODES_PAIEMENT_DEPENSE, CHAMPS_MODIFIABLES,
  validateDepense, entreeHistorique,
};

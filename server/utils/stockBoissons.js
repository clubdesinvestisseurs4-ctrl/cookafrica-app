// Stock des boissons (décision du 2026-11-12) — la nourriture n'est pas suivie.
// Comme les dépenses : on saisit ce qui ENTRE (livraisons, achats) et ce qui SORT (sorties du
// jour pour la vente, casse, offert…). Les boissons sont celles du menu (catégorie Boissons) :
// pas de liste de marques à tenir à part, les prix de vente sont déjà dans le menu.
//
// Deux endroits (décision du 2026-11-16) : une bouteille sortie « pour la vente » n'est pas
// vendue tout de suite, elle va au FRIGO / BAR et y reste jusqu'à sa vente.
//   Réserve = entrées (achat, retour du frigo, correction) − sorties (vers le frigo, casse,
//             offert, perte, correction).
//   Frigo   = sorties vers le frigo − ventes en caisse − retours à la réserve, suivi en continu
//             (pas seulement sur la période affichée) depuis le premier mouvement de la boisson,
//             ou depuis son dernier COMPTAGE du frigo, qui fixe la quantité réelle (fin de journée).
//   L'écart d'un comptage (attendu − compté) = bouteilles manquantes (offertes, perdues, vendues
//   sans facture) ; négatif = vendues en caisse sans être sorties de la réserve.
// RÉATTRIBUTION : une vente tapée en caisse sous une boisson mais servie avec une autre
//   (ex. 1 « Celeste 0.5 L » = 2 bouteilles « Celeste 0.33 L ») : le frigo et le contrôle
//   comptent la boisson réellement servie. L'argent encaissé ne change pas.
// Logique pure, testée dans test/stock-boissons.test.js.
const { estEncaissee } = require('./bilan');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MOTIFS = {
  entree: ['achat', 'retour', 'correction'],
  sortie: ['vente', 'casse', 'offert', 'perte', 'correction'],
  comptage: ['frigo'],
  reattribution: ['caisse'],
};

const entier = (v, min) => { const q = Number(v); return Number.isInteger(q) && q >= min && q <= 10_000 ? q : null; };
const vide = (v) => v === undefined || v === null || v === '';

// body : { date, sens, motif, note, lignes: [{ menuItemId, quantite, prixAchat? }] }
//   sens 'comptage' : quantite = bouteilles comptées au frigo (0 accepté, case vide = non comptée)
//   sens 'reattribution' : { de: { menuItemId, quantite }, vers: { menuItemId, quantite } }
// boissons : Map menuItemId → article du menu. Retourne { data } ou { error }.
function validerMouvement(body, boissons, today) {
  const b = body || {};
  if (!DATE_RE.test(b.date || '')) return { error: 'Date invalide (AAAA-MM-JJ)' };
  if (b.date > today) return { error: 'La date ne peut pas être dans le futur' };
  if (!MOTIFS[b.sens]) return { error: 'Type de saisie invalide' };
  const motif = b.motif || MOTIFS[b.sens][0]; // achat, vente, frigo, caisse
  if (!MOTIFS[b.sens].includes(motif)) return { error: `Motif invalide pour une ${b.sens}` };
  const note = String(b.note || '').trim().slice(0, 200);

  if (b.sens === 'reattribution') {
    const de = b.de || {}, vers = b.vers || {};
    const a = boissons.get(de.menuItemId), c = boissons.get(vers.menuItemId);
    if (!a || !c) return { error: 'Boisson inconnue dans le menu' };
    if (de.menuItemId === vers.menuItemId) return { error: 'Choisissez deux boissons différentes' };
    const qa = entier(de.quantite, 1), qc = entier(vers.quantite, 1);
    if (!qa || !qc) return { error: 'Quantité invalide (nombre entier positif)' };
    return { data: { date: b.date, sens: b.sens, motif, note,
      de: { menuItemId: de.menuItemId, nom: a.nom, quantite: qa },
      vers: { menuItemId: vers.menuItemId, nom: c.nom, quantite: qc } } };
  }

  const lignes = [];
  const vus = new Set();
  for (const l of Array.isArray(b.lignes) ? b.lignes : []) {
    if (b.sens === 'comptage' ? vide(l.quantite) : !Number(l.quantite)) continue; // ligne laissée vide
    const q = entier(l.quantite, b.sens === 'comptage' ? 0 : 1);
    if (q === null) return { error: 'Quantité invalide (nombre entier positif)' };
    const article = boissons.get(l.menuItemId);
    if (!article) return { error: 'Boisson inconnue dans le menu' };
    if (vus.has(l.menuItemId)) return { error: `${article.nom} saisie deux fois` };
    vus.add(l.menuItemId);
    const ligne = { menuItemId: l.menuItemId, nom: article.nom, quantite: q };
    if (b.sens === 'entree') {
      const prixAchat = vide(l.prixAchat) ? null : Number(l.prixAchat);
      if (prixAchat !== null && !(prixAchat >= 0)) return { error: 'Prix d\'achat invalide' };
      ligne.prixAchat = prixAchat;
    }
    lignes.push(ligne);
  }
  if (!lignes.length) return { error: 'Indiquez au moins une quantité' };
  return { data: { date: b.date, sens: b.sens, motif, note, lignes } };
}

// Boissons vendues en caisse, par jour puis par article : Map date → Map id → { quantite, montant }.
function ventesCaisseParJour(factures, debut, fin, boissonsParNom) {
  const jours = new Map();
  for (const f of factures || []) {
    if (!estEncaissee(f) || f.date < debut || f.date > fin) continue;
    for (const i of f.items || []) {
      if (i.categorie !== 'Boissons') continue;
      const id = i.menuItemId || (boissonsParNom.get(i.nom) || {}).id || `nom:${i.nom}`;
      if (!jours.has(f.date)) jours.set(f.date, new Map());
      const j = jours.get(f.date);
      const v = j.get(id) || { quantite: 0, montant: 0 };
      v.quantite += Number(i.quantite) || 0;
      v.montant += Number(i.sousTotal) || 0;
      j.set(id, v);
    }
  }
  return jours;
}

// Boissons vendues en caisse sur [debut, fin] : quantité et montant par article.
function ventesCaisse(factures, debut, fin, boissonsParNom) {
  const ventes = new Map();
  for (const j of ventesCaisseParJour(factures, debut, fin, boissonsParNom).values()) {
    for (const [id, v] of j) {
      const t = ventes.get(id) || { quantite: 0, montant: 0 };
      t.quantite += v.quantite; t.montant += v.montant;
      ventes.set(id, t);
    }
  }
  return ventes;
}

const lignesTouchees = (m) => m.sens === 'reattribution' ? [m.de, m.vers] : (m.lignes || []);
const actif = (m, fin) => !m.supprime && m.date <= fin;

// Date à partir de laquelle il faut les factures pour calculer le frigo à `fin` : le lendemain
// du dernier comptage de chaque boisson, sinon son premier mouvement. Jamais après `debut`.
function debutLectureFactures(mouvements, debut, fin) {
  const premier = new Map(), comptage = new Map();
  for (const m of mouvements || []) {
    if (!actif(m, fin)) continue;
    for (const l of lignesTouchees(m)) {
      if (!premier.has(l.menuItemId) || m.date < premier.get(l.menuItemId)) premier.set(l.menuItemId, m.date);
      if (m.sens === 'comptage' && (!comptage.has(l.menuItemId) || m.date > comptage.get(l.menuItemId))) comptage.set(l.menuItemId, m.date);
    }
  }
  let d = debut;
  for (const [id, p] of premier) {
    const depuis = comptage.has(id) ? lendemain(comptage.get(id)) : p;
    if (depuis < d) d = depuis;
  }
  return d;
}

function lendemain(date) {
  const t = new Date(`${date}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

// État du stock sur [debut, fin]. `mouvements` : TOUS les mouvements (le stock de départ est la
// somme de ceux d'avant `debut`). `factures` : au moins depuis debutLectureFactures(…).
function calculerEtat({ boissons, mouvements, factures, debut, fin }) {
  const parNom = new Map(boissons.map(b => [b.nom, b]));
  const lignes = new Map(boissons.map(b => [b.id, {
    menuItemId: b.id, nom: b.nom, prix: Number(b.prix) || 0,
    stockDebut: 0, entrees: 0, sorties: 0, sortiesVente: 0, sortiesAutres: 0, retours: 0,
    vendusCaisse: 0, montantCaisse: 0, reattribues: 0, frigo: 0, manquants: 0, dernierComptage: null,
  }]));
  const actifs = (mouvements || []).filter(m => actif(m, fin))
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

  // 1. Réserve (comme avant) et compteurs de la période.
  for (const m of actifs) {
    if (m.sens !== 'entree' && m.sens !== 'sortie') continue;
    const signe = m.sens === 'entree' ? 1 : -1;
    for (const l of m.lignes || []) {
      const r = lignes.get(l.menuItemId);
      if (!r) continue; // boisson retirée du menu depuis
      if (m.date < debut) { r.stockDebut += signe * l.quantite; continue; }
      if (m.sens === 'entree') { r.entrees += l.quantite; if (m.motif === 'retour') r.retours += l.quantite; }
      else {
        r.sorties += l.quantite;
        if (m.motif === 'vente') r.sortiesVente += l.quantite; else r.sortiesAutres += l.quantite;
      }
    }
  }

  // 2. Ventes en caisse par jour, corrigées des réattributions (boisson réellement servie).
  const ventes = ventesCaisseParJour(factures, '0000-00-00', fin, parNom);
  const vendu = (date, id) => ventes.get(date)?.get(id)?.quantite || 0;
  const ajuster = (date, id, dq) => {
    if (!ventes.has(date)) ventes.set(date, new Map());
    const j = ventes.get(date);
    const v = j.get(id) || { quantite: 0, montant: 0 };
    v.quantite += dq;
    j.set(id, v);
  };
  for (const m of actifs) {
    if (m.sens !== 'reattribution') continue;
    ajuster(m.date, m.de.menuItemId, -m.de.quantite);
    ajuster(m.date, m.vers.menuItemId, m.vers.quantite);
    if (m.date >= debut) {
      const a = lignes.get(m.de.menuItemId), c = lignes.get(m.vers.menuItemId);
      if (a) a.reattribues -= m.de.quantite;
      if (c) c.reattribues += m.vers.quantite;
    }
  }
  for (const [date, j] of ventes) {
    if (date < debut || date > fin) continue;
    for (const [id, v] of j) {
      const r = lignes.get(id);
      if (r) { r.vendusCaisse += v.quantite; r.montantCaisse += v.montant; }
    }
  }

  // 3. Frigo, jour par jour depuis le premier mouvement de chaque boisson : + sorties vers le
  //    frigo, − retours à la réserve, − ventes ; un comptage (fin de journée) fixe la valeur.
  const parJour = new Map();
  for (const m of actifs) {
    if (!parJour.has(m.date)) parJour.set(m.date, []);
    parJour.get(m.date).push(m);
  }
  const jours = [...new Set([...parJour.keys(), ...ventes.keys()])].filter(d => d <= fin).sort();
  const suivi = new Set();
  for (const date of jours) {
    const ms = parJour.get(date) || [];
    for (const m of ms) for (const l of lignesTouchees(m)) suivi.add(l.menuItemId);
    for (const m of ms) {
      if (m.sens === 'sortie' && m.motif === 'vente') for (const l of m.lignes) { const r = lignes.get(l.menuItemId); if (r) r.frigo += l.quantite; }
      if (m.sens === 'entree' && m.motif === 'retour') for (const l of m.lignes) { const r = lignes.get(l.menuItemId); if (r) r.frigo -= l.quantite; }
    }
    for (const id of suivi) { const r = lignes.get(id); if (r) r.frigo -= vendu(date, id); }
    for (const m of ms) {
      if (m.sens !== 'comptage') continue;
      for (const l of m.lignes) {
        const r = lignes.get(l.menuItemId);
        if (!r) continue;
        if (date >= debut) r.manquants += r.frigo - l.quantite;
        r.frigo = l.quantite;
        r.dernierComptage = date;
      }
    }
  }

  const resultat = [...lignes.values()].map(r => {
    const stockFin = r.stockDebut + r.entrees - r.sorties;
    const total = stockFin + Math.max(0, r.frigo);
    return { ...r, stockFin, total, valeurStock: total * r.prix };
  }).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
  const somme = (k) => resultat.reduce((s, r) => s + r[k], 0);
  return {
    debut, fin,
    lignes: resultat,
    totaux: {
      bouteillesEnStock: somme('stockFin'),
      bouteillesFrigo: resultat.reduce((s, r) => s + Math.max(0, r.frigo), 0),
      valeurStock: somme('valeurStock'),
      entrees: somme('entrees'),
      sortiesVente: somme('sortiesVente'),
      valeurSortiesVente: resultat.reduce((s, r) => s + r.sortiesVente * r.prix, 0),
      sortiesAutres: somme('sortiesAutres'),
      vendusCaisse: somme('vendusCaisse'),
      montantCaisse: somme('montantCaisse'),
      manquants: somme('manquants'),
      valeurManquants: resultat.reduce((s, r) => s + r.manquants * r.prix, 0),
      frigoNegatif: resultat.filter(r => r.frigo < 0).length,
      enRupture: resultat.filter(r => r.stockFin <= 0 && (r.entrees || r.stockDebut || r.sorties)).length,
    },
  };
}

module.exports = { MOTIFS, validerMouvement, ventesCaisse, debutLectureFactures, calculerEtat };

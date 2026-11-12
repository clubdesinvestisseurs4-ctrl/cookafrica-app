// Stock des boissons (décision du 2026-11-12) — la nourriture n'est pas suivie.
// Comme les dépenses : on saisit ce qui ENTRE (livraisons, achats) et ce qui SORT (sorties du
// jour pour la vente, casse, offert…). Les boissons sont celles du menu (catégorie Boissons) :
// pas de liste de marques à tenir à part, les prix de vente sont déjà dans le menu.
//
// Contrôle : les sorties déclarées « vente » doivent correspondre aux boissons vendues en
// caisse (factures payées, même calcul que le tableau de bord). Un écart = boisson sortie mais
// pas facturée (oubli, perte, vol) ou vendue sans être sortie (saisie oubliée).
// Logique pure, testée dans test/stock-boissons.test.js.
const { estEncaissee } = require('./bilan');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MOTIFS = {
  entree: ['achat', 'retour', 'correction'],
  sortie: ['vente', 'casse', 'offert', 'perte', 'correction'],
};

// body : { date, sens, motif, note, lignes: [{ menuItemId, quantite, prixAchat? }] }
// boissons : Map menuItemId → article du menu. Retourne { data: { date, sens, motif, note, lignes } } ou { error }.
function validerMouvement(body, boissons, today) {
  const b = body || {};
  if (!DATE_RE.test(b.date || '')) return { error: 'Date invalide (AAAA-MM-JJ)' };
  if (b.date > today) return { error: 'La date ne peut pas être dans le futur' };
  if (!MOTIFS[b.sens]) return { error: 'Sens invalide (entree ou sortie)' };
  const motif = b.motif || (b.sens === 'entree' ? 'achat' : 'vente');
  if (!MOTIFS[b.sens].includes(motif)) return { error: `Motif invalide pour une ${b.sens}` };
  const lignes = [];
  for (const l of Array.isArray(b.lignes) ? b.lignes : []) {
    const q = Number(l.quantite);
    if (!q) continue; // ligne laissée vide dans le formulaire
    if (!Number.isInteger(q) || q < 0 || q > 10_000) return { error: 'Quantité invalide (nombre entier positif)' };
    const article = boissons.get(l.menuItemId);
    if (!article) return { error: 'Boisson inconnue dans le menu' };
    const prixAchat = l.prixAchat === undefined || l.prixAchat === '' || l.prixAchat === null ? null : Number(l.prixAchat);
    if (prixAchat !== null && !(prixAchat >= 0)) return { error: 'Prix d\'achat invalide' };
    lignes.push({ menuItemId: l.menuItemId, nom: article.nom, quantite: q, prixAchat });
  }
  if (!lignes.length) return { error: 'Indiquez au moins une quantité' };
  return { data: { date: b.date, sens: b.sens, motif, note: String(b.note || '').trim().slice(0, 200), lignes } };
}

// Boissons vendues en caisse sur [debut, fin] : quantité et montant par article.
function ventesCaisse(factures, debut, fin, boissonsParNom) {
  const ventes = new Map();
  for (const f of factures || []) {
    if (!estEncaissee(f) || f.date < debut || f.date > fin) continue;
    for (const i of f.items || []) {
      if (i.categorie !== 'Boissons') continue;
      const id = i.menuItemId || (boissonsParNom.get(i.nom) || {}).id || `nom:${i.nom}`;
      const v = ventes.get(id) || { quantite: 0, montant: 0 };
      v.quantite += Number(i.quantite) || 0;
      v.montant += Number(i.sousTotal) || 0;
      ventes.set(id, v);
    }
  }
  return ventes;
}

// État du stock sur [debut, fin]. `mouvements` : TOUS les mouvements non supprimés jusqu'à `fin`
// (le stock de départ est la somme de ceux d'avant `debut`).
function calculerEtat({ boissons, mouvements, factures, debut, fin }) {
  const parNom = new Map(boissons.map(b => [b.nom, b]));
  const lignes = new Map(boissons.map(b => [b.id, {
    menuItemId: b.id, nom: b.nom, prix: Number(b.prix) || 0,
    stockDebut: 0, entrees: 0, sorties: 0, sortiesVente: 0, sortiesAutres: 0, vendusCaisse: 0, montantCaisse: 0,
  }]));
  for (const m of mouvements || []) {
    if (m.supprime || m.date > fin) continue;
    const signe = m.sens === 'entree' ? 1 : -1;
    for (const l of m.lignes || []) {
      const r = lignes.get(l.menuItemId);
      if (!r) continue; // boisson retirée du menu depuis
      if (m.date < debut) { r.stockDebut += signe * l.quantite; continue; }
      if (m.sens === 'entree') r.entrees += l.quantite;
      else {
        r.sorties += l.quantite;
        if (m.motif === 'vente') r.sortiesVente += l.quantite; else r.sortiesAutres += l.quantite;
      }
    }
  }
  for (const [id, v] of ventesCaisse(factures, debut, fin, parNom)) {
    const r = lignes.get(id);
    if (r) { r.vendusCaisse = v.quantite; r.montantCaisse = v.montant; }
  }
  const resultat = [...lignes.values()].map(r => {
    const stockFin = r.stockDebut + r.entrees - r.sorties;
    return { ...r, stockFin, valeurStock: stockFin * r.prix, ecart: r.sortiesVente - r.vendusCaisse };
  }).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
  const somme = (k) => resultat.reduce((s, r) => s + r[k], 0);
  return {
    debut, fin,
    lignes: resultat,
    totaux: {
      bouteillesEnStock: somme('stockFin'),
      valeurStock: somme('valeurStock'),
      entrees: somme('entrees'),
      sortiesVente: somme('sortiesVente'),
      valeurSortiesVente: resultat.reduce((s, r) => s + r.sortiesVente * r.prix, 0),
      sortiesAutres: somme('sortiesAutres'),
      vendusCaisse: somme('vendusCaisse'),
      montantCaisse: somme('montantCaisse'),
      articlesEnEcart: resultat.filter(r => r.ecart !== 0).length,
      enRupture: resultat.filter(r => r.stockFin <= 0 && (r.entrees || r.stockDebut || r.sorties)).length,
    },
  };
}

module.exports = { MOTIFS, validerMouvement, ventesCaisse, calculerEtat };

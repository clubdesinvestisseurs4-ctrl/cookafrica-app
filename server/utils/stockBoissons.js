// Stock des boissons (décision du 2026-11-12) — la nourriture n'est pas suivie.
// Les boissons sont celles du menu (catégorie Boissons) : leurs prix de vente y sont déjà.
//
// Tout est saisi À LA MAIN (décision du 2026-11-17) : rien n'est déduit de la caisse, qui
// mélangeait les comptes (bouteilles sorties plusieurs jours avant d'être vendues, ventes
// tapées sous une autre boisson…).
//   ENTRÉE  : livraisons, achats (+ correction).
//   SORTIE  : chaque soir, les bouteilles vendues dans la journée (motif « vente »), et la casse,
//             les bouteilles offertes, perdues (+ correction).
//   COMPTAGE du soir : les bouteilles réellement présentes. Il fixe le stock en fin de journée ;
//             l'écart avec le stock attendu (attendu − compté) est affiché, rien n'est inventé.
//   Stock = entrées − sorties, remis au compté à chaque comptage.
// Les anciens types de saisie (comptage du frigo, correction de vente) ne sont plus acceptés et
// sont ignorés par le calcul s'il en restait.
// Logique pure, testée dans test/stock-boissons.test.js.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MOTIFS = {
  entree: ['achat', 'correction'],
  sortie: ['vente', 'casse', 'offert', 'perte', 'correction'],
  comptage: ['stock'],
};

const entier = (v, min) => { const q = Number(v); return Number.isInteger(q) && q >= min && q <= 10_000 ? q : null; };
const vide = (v) => v === undefined || v === null || v === '';

// body : { date, sens, motif, note, lignes: [{ menuItemId, quantite, prixAchat? }] }
//   sens 'comptage' : quantite = bouteilles comptées (0 accepté, case vide = non comptée)
// boissons : Map menuItemId → article du menu. Retourne { data } ou { error }.
function validerMouvement(body, boissons, today) {
  const b = body || {};
  if (!DATE_RE.test(b.date || '')) return { error: 'Date invalide (AAAA-MM-JJ)' };
  if (b.date > today) return { error: 'La date ne peut pas être dans le futur' };
  if (!MOTIFS[b.sens]) return { error: 'Type de saisie invalide' };
  const motif = b.motif || MOTIFS[b.sens][0]; // achat, vente, stock
  if (!MOTIFS[b.sens].includes(motif)) return { error: `Motif invalide pour une ${b.sens}` };
  const note = String(b.note || '').trim().slice(0, 200);

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

const actif = (m, fin) => !m.supprime && m.date <= fin && MOTIFS[m.sens]?.includes(m.motif);

// Dans une journée : entrées et sorties d'abord, le comptage du soir en dernier.
const ordreDuJour = (m) => (m.sens === 'comptage' ? 1 : 0);

// État du stock sur [debut, fin]. `mouvements` : TOUS les mouvements (le stock de départ se
// calcule depuis le premier).
function calculerEtat({ boissons, mouvements, debut, fin }) {
  const lignes = new Map(boissons.map(b => [b.id, {
    menuItemId: b.id, nom: b.nom, prix: Number(b.prix) || 0,
    stockDebut: 0, entrees: 0, sortiesVente: 0, sortiesAutres: 0, ecart: 0,
    stock: 0, dernierComptage: null, compteLe: null,
  }]));
  const actifs = (mouvements || []).filter(m => actif(m, fin)).sort((a, b) =>
    a.date.localeCompare(b.date) || ordreDuJour(a) - ordreDuJour(b)
    || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

  let debutPasse = false;
  for (const m of actifs) {
    if (!debutPasse && m.date >= debut) {
      for (const r of lignes.values()) r.stockDebut = r.stock;
      debutPasse = true;
    }
    const dansPeriode = m.date >= debut;
    for (const l of m.lignes || []) {
      const r = lignes.get(l.menuItemId);
      if (!r) continue; // boisson retirée du menu depuis
      if (m.sens === 'entree') {
        r.stock += l.quantite;
        if (dansPeriode) r.entrees += l.quantite;
      } else if (m.sens === 'sortie') {
        r.stock -= l.quantite;
        if (dansPeriode) {
          if (m.motif === 'vente') r.sortiesVente += l.quantite; else r.sortiesAutres += l.quantite;
        }
      } else {
        // Comptage du soir : l'écart (attendu − compté) est gardé pour information.
        if (dansPeriode) r.ecart += r.stock - l.quantite;
        r.stock = l.quantite;
        r.dernierComptage = m.date;
        r.compteLe = l.quantite;
      }
    }
  }
  if (!debutPasse) for (const r of lignes.values()) r.stockDebut = r.stock;

  const resultat = [...lignes.values()].map(r => ({
    ...r,
    stockFin: r.stock,
    valeurStock: Math.max(0, r.stock) * r.prix,
    valeurVentes: r.sortiesVente * r.prix,
  })).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
  const somme = (k) => resultat.reduce((s, r) => s + r[k], 0);
  return {
    debut, fin,
    lignes: resultat,
    totaux: {
      bouteillesEnStock: resultat.reduce((s, r) => s + Math.max(0, r.stockFin), 0),
      valeurStock: somme('valeurStock'),
      entrees: somme('entrees'),
      sortiesVente: somme('sortiesVente'),
      valeurVentes: somme('valeurVentes'),
      sortiesAutres: somme('sortiesAutres'),
      ecart: somme('ecart'),
      valeurEcart: resultat.reduce((s, r) => s + r.ecart * r.prix, 0),
      stockNegatif: resultat.filter(r => r.stockFin < 0).length,
      enRupture: resultat.filter(r => r.stockFin <= 0 && (r.entrees || r.stockDebut || r.sortiesVente || r.sortiesAutres)).length,
    },
  };
}

module.exports = { MOTIFS, validerMouvement, calculerEtat };

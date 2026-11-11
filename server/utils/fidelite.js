// Bons fidélité « loterie » imprimés en QR code sous le reçu (décision du 2026-11-11).
//
// Règles :
//   - un bon par facture payée SUR PLACE, d'au moins 10 000 FCFA, contenant un BUFFET ;
//   - le lot est tiré au sort à l'impression mais caché au client : il le découvre en revenant ;
//   - valable à partir du lendemain, pendant 15 jours, une seule fois ;
//   - plus l'addition est élevée, plus les lots rares (plat offert, remise) sont probables.
//     Les boissons font la marge : le jus offert reste plafonné à 20-25 % de chances.
// Logique pure (testée dans test/fidelite.test.js) ; les accès Firestore sont dans routes/fidelite.js.
const crypto = require('crypto');

const MONTANT_MINIMUM = 10_000;
const VALIDITE_JOURS = 15;

const LOTS = {
  accompagnement: 'Un accompagnement offert',
  jus: 'Un jus offert',
  remise10: '10 % de réduction sur l\'addition',
  plat: 'Un plat offert',
};

// Chances en % par palier d'addition (chaque ligne fait 100).
const PALIERS = [
  { min: 40_000, nom: 'or',     chances: { accompagnement: 40, jus: 20, remise10: 28, plat: 12 } },
  { min: 20_000, nom: 'argent', chances: { accompagnement: 55, jus: 22, remise10: 18, plat: 5 } },
  { min: MONTANT_MINIMUM, nom: 'bronze', chances: { accompagnement: 70, jus: 25, remise10: 5, plat: 0 } },
];

const contientBuffet = (items) => (items || []).some(i => i.categorie === 'Buffet');

// modeConsommation : celui de la commande d'origine ('sur-place' | 'a-emporter' | absent).
function estEligible({ total, items, modeConsommation }) {
  return modeConsommation !== 'a-emporter' && Number(total) >= MONTANT_MINIMUM && contientBuffet(items);
}

const palierPour = (total) => PALIERS.find(p => Number(total) >= p.min) || null;

// `alea` : entier 0..99 (injectable pour les tests).
function tirerLot(total, alea = crypto.randomInt(100)) {
  const palier = palierPour(total);
  if (!palier) return null;
  let cumul = 0;
  for (const [type, pct] of Object.entries(palier.chances)) {
    cumul += pct;
    if (alea < cumul) return { type, libelle: LOTS[type], palier: palier.nom };
  }
  return { type: 'accompagnement', libelle: LOTS.accompagnement, palier: palier.nom };
}

// 10 caractères sans 0/O/1/I (lisibles à la main si le QR est abîmé), ~50 bits d'aléa.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genererCode() {
  let s = '';
  for (let i = 0; i < 10; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}
const normaliserCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);

const ajouterJours = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function periodeValidite(dateFacture) {
  return { valableDes: ajouterJours(dateFacture, 1), expireLe: ajouterJours(dateFacture, VALIDITE_JOURS) };
}

// Ce que voit la caisse au scan. `aujourdhui` : AAAA-MM-JJ.
function etatBon(bon, aujourdhui) {
  if (!bon) return { valide: false, raison: 'inconnu', message: 'Bon inconnu.' };
  if (bon.statut === 'utilise') return { valide: false, raison: 'utilise', message: `Bon déjà utilisé le ${String(bon.utiliseLe || '').slice(0, 10)}.` };
  if (aujourdhui < bon.valableDes) return { valide: false, raison: 'trop-tot', message: `Bon valable à partir du ${bon.valableDes} (revenez une prochaine fois !).` };
  if (aujourdhui > bon.expireLe) return { valide: false, raison: 'expire', message: `Bon expiré depuis le ${bon.expireLe}.` };
  return { valide: true, raison: 'ok', message: `Gagné : ${bon.lot.libelle} !` };
}

// Ligne négative ajoutée à la facture du retour pour appliquer le cadeau automatiquement.
// Article offert = un exemplaire du moins cher des articles concernés présents sur la facture
// (le client doit donc commander l'accompagnement / le jus / le plat) ; remise = 10 % du total
// hors autres remises. Retourne { ligne } ou { error }.
const CIBLES = {
  accompagnement: { categories: ['Accompagnement'], absent: 'Ajoutez d\'abord l\'accompagnement choisi par le client sur la facture.' },
  jus: { categories: ['Boissons'], nom: /jus/i, absent: 'Ajoutez d\'abord le jus choisi par le client sur la facture.' },
  plat: { categories: ['Plats', 'Plats (sauce)'], absent: 'Ajoutez d\'abord le plat choisi par le client sur la facture.' },
};
const CATEGORIE_REMISE = 'Remise';

function ligneCadeau(bon, items) {
  const lignes = items || [];
  if (lignes.some(i => i.bonCode === bon.code)) return { error: 'Ce bon est déjà appliqué sur cette facture.' };
  let montant;
  if (bon.lot.type === 'remise10') {
    const base = lignes.filter(i => i.categorie !== CATEGORIE_REMISE).reduce((s, i) => s + (Number(i.sousTotal) || 0), 0);
    montant = Math.round(base * 0.10);
  } else {
    const cible = CIBLES[bon.lot.type];
    const candidats = lignes.filter(i => cible.categories.includes(i.categorie) && (!cible.nom || cible.nom.test(i.nom || '')) && Number(i.prix) > 0);
    if (!candidats.length) return { error: cible.absent };
    montant = Math.min(...candidats.map(i => Number(i.prix)));
  }
  if (!(montant > 0)) return { error: 'Rien à déduire sur cette facture.' };
  return {
    ligne: {
      menuItemId: '', nom: `Bon cadeau ${bon.code} : ${bon.lot.libelle.toLowerCase()}`,
      prix: -montant, quantite: 1, sousTotal: -montant, categorie: CATEGORIE_REMISE, bonCode: bon.code,
    },
  };
}

module.exports = {
  MONTANT_MINIMUM, VALIDITE_JOURS, LOTS, PALIERS, CATEGORIE_REMISE,
  estEligible, palierPour, tirerLot, genererCode, normaliserCode, periodeValidite, etatBon, ligneCadeau,
};

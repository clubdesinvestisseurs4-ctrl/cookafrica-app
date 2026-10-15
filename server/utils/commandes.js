// Logique partagée entre la création de commande "staff" (routes/commandes.js)
// et la création de commande "client" (routes/commande-publique.js).

async function getNextNumero(db) {
  const snap = await db.collection('commandes').orderBy('createdAt', 'desc').limit(1).get();
  if (snap.empty) return 'CMD-0001';
  const last = snap.docs[0].data();
  const lastNum = parseInt((last.numero || 'CMD-0000').split('-')[1] || '0', 10);
  return `CMD-${String(lastNum + 1).padStart(4, '0')}`;
}

// Décrémente quantiteRestante dans stocks_plats pour chaque article commandé.
// Retourne la liste des noms d'articles désormais épuisés.
async function decrementStocksForItems(db, items, now) {
  const today = now.toISOString().split('T')[0];
  const epuises = [];
  for (const item of items) {
    if (!item.menuItemId) continue;
    const stockRef = db.collection('stocks_plats').doc(`${item.menuItemId}_${today}`);
    const stockDoc = await stockRef.get();
    if (stockDoc.exists) {
      const newRestante = Math.max(0, stockDoc.data().quantiteRestante - item.quantite);
      await stockRef.update({ quantiteRestante: newRestante, updatedAt: now.toISOString() });
      if (newRestante === 0) epuises.push(item.nom);
    }
  }
  return epuises;
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

const MOTS_SUR_PLACE = ['boisson', 'buffet'];

// Classement automatique sur place / à emporter (demande du 2026-10-14) : les commandes
// en ligne contenant une boisson ou un buffet sont presque toujours consommées sur
// place, le reste part à emporter. On regarde la catégorie ET le nom de l'article —
// une catégorie mal renseignée (ex. un "Buffet Mixte" classé "Plats") ne doit pas
// empêcher la détection.
function determineModeConsommation(items) {
  const contientSurPlace = (items || []).some(item => {
    const texte = normalize(`${item.categorie} ${item.nom}`);
    return MOTS_SUR_PLACE.some(mot => texte.includes(mot));
  });
  return contientSurPlace ? 'sur-place' : 'a-emporter';
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ROLES_PEUVENT_ANTIDATER = ['admin', 'caissiere'];
const ANTIDATE_MAX_JOURS = 30;

// Permet de saisir aujourd'hui une commande qui a réellement eu lieu un jour antérieur
// (ex: oubliée hier, retrouvée sur un carnet) afin qu'elle compte dans le bilan du BON
// jour - createFactureFromCommande (utils/factures.js) reprend déjà `commande.date` pour
// la facture, donc fixer correctement cette date ici suffit à tout faire remonter au bon
// endroit dans les rapports. Restreint à admin/caissière (pas serveur/caissier-en-ligne)
// pour qu'un simple correctif de saisie ne devienne pas un moyen de déplacer des ventes
// d'un jour à l'autre sans contrôle.
function resolveCommandeDate(requestedDate, role, now) {
  const today = now.toISOString().split('T')[0];
  if (!requestedDate || !ROLES_PEUVENT_ANTIDATER.includes(role)) return { date: today };
  if (!DATE_RE.test(requestedDate)) return { error: 'Date invalide (format attendu AAAA-MM-JJ)' };
  if (requestedDate > today) return { error: 'La date ne peut pas être dans le futur' };
  const joursEcoules = (new Date(`${today}T00:00:00Z`) - new Date(`${requestedDate}T00:00:00Z`)) / 86_400_000;
  if (joursEcoules > ANTIDATE_MAX_JOURS) {
    return { error: `La date ne peut pas remonter à plus de ${ANTIDATE_MAX_JOURS} jours` };
  }
  return { date: requestedDate };
}

module.exports = {
  getNextNumero, decrementStocksForItems, determineModeConsommation, resolveCommandeDate,
};
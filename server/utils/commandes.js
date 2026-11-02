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

const MODES_CONSOMMATION = ['sur-place', 'a-emporter'];

// Mode proposé par défaut à la création, quel que soit l'écran (demande du 2026-11-01) :
// un serveur prend les commandes en salle → toujours "sur place" ; pour tous les autres
// (admin, caissière, caissier en ligne, client web) c'est la règle boisson/buffet
// ci-dessus. L'utilisateur peut toujours corriger avant de valider (voir resolveModeConsommation).
function modeParDefaut(role, items) {
  return role === 'serveur' ? 'sur-place' : determineModeConsommation(items);
}

// Mode final d'une commande + d'où il vient : 'auto' si c'est celui de la règle, 'manuel'
// si l'utilisateur l'a changé. Une valeur absente ou inconnue retombe sur la règle — un
// client hors-ligne d'avant cette fonctionnalité (file d'attente rejouée) n'envoie rien.
function resolveModeConsommation(requested, role, items) {
  const auto = modeParDefaut(role, items);
  if (!MODES_CONSOMMATION.includes(requested) || requested === auto) {
    return { modeConsommation: auto, modeSource: 'auto' };
  }
  return { modeConsommation: requested, modeSource: 'manuel' };
}

// Une boisson ajoutée sur la facture à l'encaissement doit faire passer une commande caisse
// en "sur place", comme si elle avait été dans la commande dès le départ — seulement si le
// mode est encore celui de la règle (jamais un choix manuel) et pour une commande créée
// depuis le 2026-11-01 (createdByRole connu). Un serveur reste toujours "sur place".
// Retourne la mise à jour à appliquer à la commande, ou null.
function modeApresFacture(commande, factureItems) {
  if (!commande || commande.modeSource !== 'auto' || !commande.createdByRole) return null;
  const mode = modeParDefaut(commande.createdByRole, [...(commande.items || []), ...(factureItems || [])]);
  return mode !== commande.modeConsommation ? { modeConsommation: mode } : null;
}

// Supplément (demande du 2026-11-02) : un client qui redemande du riz ou une boisson après
// facturation donne lieu à une nouvelle commande, qui n'est pas une commande à part entière
// pour les statistiques (son argent compte, pas son nombre). Proposé d'office quand la
// commande ne contient QUE des accompagnements et/ou des boissons ; corrigible à la main.
function estArticleSupplement(item) {
  const categorie = normalize(item.categorie);
  if (normalize(item.nom).includes('buffet')) return false;
  return categorie.includes('accompagnement') || categorie.includes('boisson');
}

function estSupplementAuto(items) {
  return Array.isArray(items) && items.length > 0 && items.every(estArticleSupplement);
}

// `requested` : true/false si l'utilisateur a coché/décoché la case, sinon la règle.
function resolveSupplement(requested, items) {
  const auto = estSupplementAuto(items);
  if (typeof requested !== 'boolean' || requested === auto) return { supplement: auto, supplementSource: 'auto' };
  return { supplement: requested, supplementSource: 'manuel' };
}

// Articles ajoutés sur la facture (ex. un plat en plus) : un supplément "auto" non rattaché
// redevient une vraie commande, comme pour modeApresFacture. Retourne la mise à jour ou null.
function supplementApresFacture(commande, factureItems) {
  if (!commande || commande.supplementSource !== 'auto' || commande.commandeParentId) return null;
  const supplement = estSupplementAuto([...(commande.items || []), ...(factureItems || [])]);
  return supplement !== commande.supplement ? { supplement } : null;
}

// Commande d'origine d'un supplément : doit exister, ne pas être annulée, ni être
// elle-même un supplément (on rattache toujours à la vraie commande).
async function chargerCommandeParent(db, parentId, selfId) {
  if (typeof parentId !== 'string' || !parentId || parentId === selfId) return { error: 'Commande d\'origine invalide' };
  const doc = await db.collection('commandes').doc(parentId).get();
  if (!doc.exists) return { error: 'Commande d\'origine introuvable' };
  const parent = doc.data();
  if (parent.statut === 'annulee') return { error: 'La commande d\'origine est annulée' };
  if (parent.supplement === true) return { error: 'La commande d\'origine est elle-même un supplément' };
  return { parent: { id: doc.id, ...parent } };
}

// Champs posés sur un supplément rattaché : il prend le mode de sa commande d'origine
// (modeSource 'parent' : ni la règle automatique ni les articles ne le changent ensuite).
function champsRattachement(parent) {
  return {
    supplement: true,
    supplementSource: 'manuel',
    commandeParentId: parent.id,
    commandeParentNumero: parent.numero || '',
    ...(MODES_CONSOMMATION.includes(parent.modeConsommation)
      ? { modeConsommation: parent.modeConsommation, modeSource: 'parent', modeEstime: false }
      : {}),
  };
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
  MODES_CONSOMMATION, modeParDefaut, resolveModeConsommation, modeApresFacture,
  estSupplementAuto, resolveSupplement, supplementApresFacture, chargerCommandeParent, champsRattachement,
};
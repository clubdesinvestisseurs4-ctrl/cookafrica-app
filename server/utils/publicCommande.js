// Résout les articles demandés par un client (page de commande publique, non
// authentifiée) contre le menu réel chargé côté serveur. Le nom et le prix
// viennent TOUJOURS des documents `menu` fournis par l'appelant — jamais du
// corps de la requête — pour empêcher un client de falsifier un prix depuis
// son navigateur (DevTools, requête rejouée, etc.).
const MAX_LIGNES = 30;
const MAX_QTE_PAR_LIGNE = 20;

function resolvePublicItems(requestedItems, menuDocs) {
  if (!Array.isArray(requestedItems) || requestedItems.length === 0) {
    return { error: 'Le panier est vide' };
  }
  if (requestedItems.length > MAX_LIGNES) {
    return { error: 'Trop d\'articles différents dans la commande' };
  }

  const menuById = new Map(menuDocs.map(m => [m.id, m]));
  const items = [];

  for (const requested of requestedItems) {
    const menuItem = menuById.get(requested?.menuItemId);
    if (!menuItem) return { error: 'Un article du panier n\'existe plus au menu' };
    if (menuItem.disponible === false) return { error: `"${menuItem.nom}" n'est plus disponible` };

    const quantite = Math.floor(Number(requested.quantite));
    if (!Number.isFinite(quantite) || quantite < 1 || quantite > MAX_QTE_PAR_LIGNE) {
      return { error: `Quantité invalide pour "${menuItem.nom}"` };
    }

    items.push({
      menuItemId: menuItem.id,
      nom: menuItem.nom,
      prix: Number(menuItem.prix),
      quantite,
      sousTotal: Number(menuItem.prix) * quantite,
      categorie: menuItem.categorie || '',
    });
  }

  const total = items.reduce((sum, i) => sum + i.sousTotal, 0);
  return { items, total };
}

module.exports = { resolvePublicItems, MAX_LIGNES, MAX_QTE_PAR_LIGNE };
// Whitelist des champs modifiables via PUT /api/commandes/:id.
// Empêche un utilisateur (ex. cuisinière, barman) de modifier items/total/createdBy
// d'une commande via cette route générique (mass assignment).
const ALLOWED_FIELDS = ['statut', 'note', 'tableNumero'];
const VALID_STATUTS = ['en-attente', 'en-preparation', 'prete', 'servie', 'annulee'];

// Construit l'objet de mise à jour à partir du corps de la requête.
// Retourne { error } si une valeur fournie est invalide, sinon { update }.
function buildCommandeUpdate(body, now) {
  const update = { updatedAt: now.toISOString() };
  for (const field of ALLOWED_FIELDS) {
    if (body[field] === undefined) continue;
    if (field === 'statut' && !VALID_STATUTS.includes(body.statut)) {
      return { error: 'Statut invalide' };
    }
    update[field] = body[field];
  }
  return { update };
}

module.exports = { buildCommandeUpdate, ALLOWED_FIELDS, VALID_STATUTS };

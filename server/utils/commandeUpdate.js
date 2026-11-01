// Whitelist des champs modifiables via PUT /api/commandes/:id.
// Empêche un utilisateur (ex. cuisinière, barman) de modifier items/total/createdBy
// d'une commande via cette route générique (mass assignment).
const ALLOWED_FIELDS = ['statut', 'note', 'tableNumero', 'modeConsommation'];
const VALID_STATUTS = ['en-attente', 'en-preparation', 'prete', 'servie', 'annulee'];
const VALID_MODES = ['sur-place', 'a-emporter'];
// Corriger le mode d'une commande déjà facturée/servie change les statistiques : réservé
// à ceux qui encaissent ou pilotent (le reste de cette route reste ouvert à tous les rôles).
const ROLES_MODE = ['admin', 'caissiere', 'caissier-en-ligne'];

// Construit l'objet de mise à jour à partir du corps de la requête.
// Retourne { error } si une valeur fournie est invalide, sinon { update }.
function buildCommandeUpdate(body, now, role) {
  const update = { updatedAt: now.toISOString() };
  for (const field of ALLOWED_FIELDS) {
    if (body[field] === undefined) continue;
    if (field === 'statut' && !VALID_STATUTS.includes(body.statut)) {
      return { error: 'Statut invalide' };
    }
    if (field === 'modeConsommation') {
      if (!ROLES_MODE.includes(role)) return { error: 'Accès refusé', status: 403 };
      if (!VALID_MODES.includes(body.modeConsommation)) return { error: 'Mode de consommation invalide' };
      // Correction humaine : n'est plus une estimation ni un choix automatique.
      update.modeSource = 'manuel';
      update.modeEstime = false;
    }
    update[field] = body[field];
  }
  return { update };
}

module.exports = { buildCommandeUpdate, ALLOWED_FIELDS, VALID_STATUTS, VALID_MODES, ROLES_MODE };

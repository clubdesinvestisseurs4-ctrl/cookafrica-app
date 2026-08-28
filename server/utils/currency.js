// Formatage des montants dans les messages de notification serveur — devise pilotée
// par site via CURRENCY_LABEL/CURRENCY_LOCALE (ex. FCFA/fr-FR ou USD/en-US), pour ne
// pas coder 'FCFA' en dur dans un backend qui peut désormais servir un autre site.
function formatMontant(n) {
  const locale = process.env.CURRENCY_LOCALE || 'fr-FR';
  const label  = process.env.CURRENCY_LABEL  || 'FCFA';
  return `${Number(n || 0).toLocaleString(locale)} ${label}`;
}

module.exports = { formatMontant };

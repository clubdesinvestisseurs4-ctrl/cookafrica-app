// Point d'entrée AWS Lambda — enveloppe l'app Express existante (server.js) avec
// serverless-http, sans dupliquer aucune route/logique métier. Utilisé uniquement
// par le déploiement AWS SAM (voir template.yaml) ; Render et Cloud Run continuent
// de lancer server.js directement (node server.js), qui garde son app.listen()
// normal grâce au garde `require.main === module`.
//
// Backup de secours pendant qu'un Render endormi se réveille (voir startEventSource
// et le bascule automatique dans client/app.js) : pas de SSE temps réel possible ici
// (server.js le détecte via AWS_LAMBDA_FUNCTION_NAME et ferme proprement /api/events
// au lieu de laisser Lambda couper la connexion brutalement), et binaryMediaTypes
// n'est pas nécessaire, l'API ne renvoie que du JSON.
const serverless = require('serverless-http');
const app = require('./server');

module.exports.handler = serverless(app);

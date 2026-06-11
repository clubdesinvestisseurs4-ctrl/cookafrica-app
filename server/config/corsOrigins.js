// Origines autorisées pour les requêtes cross-origin (CORS).
// Le projet Vercel "cookafrica-app" génère des URLs de prévisualisation du type
// cookafrica-app-<hash>.vercel.app ou cookafrica-app-git-<branche>-<compte>.vercel.app.
// Le motif ci-dessous couvre ces variantes sans autoriser n'importe quel projet *.vercel.app
// (ex: evil-phisher.vercel.app), qui sont créables gratuitement par n'importe qui.
const corsOrigins = [
  process.env.CLIENT_URL || 'http://localhost:5500',
  /^https:\/\/cookafrica-app(-[\w.-]+)?\.vercel\.app$/,
  /\.web\.app$/,
];

module.exports = corsOrigins;

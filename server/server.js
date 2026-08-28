require('dotenv').config();
const fs      = require('fs');
const path    = require('path');
const express = require('express');
const cors    = require('cors');
const rateLimit = require('express-rate-limit');
const jwt     = require('jsonwebtoken');
const yaml    = require('js-yaml');
const eventBus = require('./utils/eventBus');
const corsOrigins = require('./config/corsOrigins');

// Chargée une fois au démarrage — parsée en JS pour /openapi.json, servie
// telle quelle pour /openapi.yaml. Documentation publique : aucune donnée
// sensible n'y figure (schémas et routes uniquement).
const OPENAPI_YAML = fs.readFileSync(path.join(__dirname, 'openapi.yaml'), 'utf8');
const OPENAPI_DOC  = yaml.load(OPENAPI_YAML);

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Middlewares ───────────────────────────────────────────────────────────────

app.set('trust proxy', 1);

// credentials: false — l'authentification se fait via le header Authorization
// (token JWT envoyé explicitement par le client), pas via cookies.
app.use(cors({ origin: corsOrigins }));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// max relevé : plusieurs postes (cuisine, bar, facturation, admin) partagent souvent la
// même IP publique (Wi-Fi du restaurant) — le quota est par IP, pas par utilisateur.
// /api/events (SSE) est exclu : c'est une connexion longue durée, pas une rafale de requêtes.
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/api/events',
  message: { error: 'Trop de requêtes, réessayez dans 15 minutes.' },
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Trop de tentatives de connexion.' },
});

// ─── SSE — temps réel (avant rate-limiter global) ─────────────────────────────
// Token JWT transmis en query string car EventSource ne supporte pas les headers.
// Les événements ne transportent que le TYPE (ex. "commandes"), jamais de données.
app.get('/api/events', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(401).end();
  try { jwt.verify(token, process.env.JWT_SECRET); } catch { return res.status(401).end(); }

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // désactive la mise en mémoire tampon Nginx
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  eventBus.addClient(res);

  // Heartbeat toutes les 25 s — garde la connexion vivante (Render, proxies)
  const hb = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(hb); }
  }, 25_000);

  req.on('close', () => { clearInterval(hb); eventBus.removeClient(res); });
});

// ─── Routes ───────────────────────────────────────────────────────────────────

app.post('/api/auth/login', authLimiter);
app.post('/api/auth/exchange-switch-token', authLimiter);
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/commandes',     require('./routes/commandes'));
app.use('/api/menu',          require('./routes/menu'));
app.use('/api/factures',      require('./routes/factures'));
app.use('/api/stocks',        require('./routes/stocks'));
app.use('/api/stats',         require('./routes/stats'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/wifi-config',   require('./routes/wifi-config'));
app.use('/api/discount-pin',  require('./routes/discount-pin'));
app.use('/api/integration',   require('./routes/integration'));
app.use('/api/reservations',  require('./routes/reservations'));
app.use('/api/public',        require('./routes/commande-publique'));

// Annuaire multi-site — uniquement sur le backend désigné comme site "maison"
// (DIRECTORY_ENABLED=true dans son .env). Absent des autres sites : ceux-ci
// n'exposent que POST /api/auth/exchange-switch-token (voir routes/auth.js), qui
// ne fait aucune confiance à l'annuaire au-delà de vérifier sa signature.
if (process.env.DIRECTORY_ENABLED === 'true') {
  app.post('/api/directory/login', authLimiter);
  app.use('/api/directory', require('./routes/directory'));
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'Cook Africa API' });
});

// Spécification OpenAPI — publique, pour audit / import Postman / génération de client.
app.get('/openapi.json', (_req, res) => res.json(OPENAPI_DOC));
app.get('/openapi.yaml', (_req, res) => res.type('text/yaml').send(OPENAPI_YAML));

app.use((_req, res) => res.status(404).json({ error: 'Route introuvable' }));

app.use((err, _req, res, _next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Erreur interne du serveur' });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✅  Cook Africa API démarrée sur le port ${PORT}`);
  console.log(`📌  Health check : http://localhost:${PORT}/health`);
});

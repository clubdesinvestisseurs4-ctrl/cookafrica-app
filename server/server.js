require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Middlewares ───────────────────────────────────────────────────────────────

app.set('trust proxy', 1);

app.use(cors({
  origin: [
    process.env.CLIENT_URL || 'http://localhost:5500',
    /\.vercel\.app$/,
    /\.web\.app$/,
  ],
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes, réessayez dans 15 minutes.' },
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Trop de tentatives de connexion.' },
});

// ─── Routes ───────────────────────────────────────────────────────────────────

app.post('/api/auth/login', authLimiter);
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/commandes',     require('./routes/commandes'));
app.use('/api/menu',          require('./routes/menu'));
app.use('/api/factures',      require('./routes/factures'));
app.use('/api/stocks',        require('./routes/stocks'));
app.use('/api/stats',         require('./routes/stats'));
app.use('/api/notifications', require('./routes/notifications'));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'Cook Africa API' });
});

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

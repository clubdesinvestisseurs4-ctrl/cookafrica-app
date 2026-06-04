// Utilitaires de vérification Wi-Fi.
// La config (enabled + allowedIps) est stockée dans Firebase (settings/wifiConfig)
// et mise en cache en mémoire 5 minutes pour éviter les lectures répétées.
// Fallback : variables d'environnement WIFI_RESTRICTION_ENABLED / ALLOWED_IPS.

let _cache = null;
let _cacheTs = 0;
const CACHE_TTL = 5 * 60 * 1000;

function normalizeIp(ip) {
  if (ip && ip.startsWith('::ffff:')) return ip.slice(7);
  return ip || '';
}

function ipInCidr(ip, cidr) {
  try {
    const [range, bits] = cidr.split('/');
    const mask = ~((1 << (32 - parseInt(bits, 10))) - 1) >>> 0;
    const toNum = s => s.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
    return (toNum(ip) & mask) === (toNum(range) & mask);
  } catch {
    return false;
  }
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = xff.split(',')[0].trim();
    if (first) return normalizeIp(first);
  }
  return normalizeIp(req.ip);
}

function invalidateCache() {
  _cache = null;
  _cacheTs = 0;
}

async function getConfig() {
  if (_cache && Date.now() - _cacheTs < CACHE_TTL) return _cache;

  try {
    const { db } = require('../firebase-admin');
    const doc = await db.collection('settings').doc('wifiConfig').get();
    if (doc.exists) {
      _cache = doc.data();
      _cacheTs = Date.now();
      return _cache;
    }
  } catch { /* Firebase indisponible — fallback env vars */ }

  // Fallback : variables d'environnement (legacy)
  const envEnabled = process.env.WIFI_RESTRICTION_ENABLED === 'true';
  const envIps = (process.env.ALLOWED_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
  _cache = { enabled: envEnabled, allowedIps: envIps };
  _cacheTs = Date.now();
  return _cache;
}

async function isAllowedIp(req) {
  const config = await getConfig();
  if (!config.enabled) return true;
  const allowed = config.allowedIps || [];
  if (allowed.length === 0) return true;
  const ip = getClientIp(req);
  return allowed.some(entry => entry.includes('/') ? ipInCidr(ip, entry) : ip === entry);
}

module.exports = { normalizeIp, ipInCidr, getClientIp, isAllowedIp, getConfig, invalidateCache };

// Code OTP admin requis pour qu'une caissière baisse le prix d'un article de
// facture sous son tarif catalogue (menu). L'admin le génère à la demande
// (settings/discountOtp : codeHash + expiresAt) — pas de code fixe, il expire
// après "windowMinutes" (settings/discountOtpConfig, réglable, défaut 5 min).
// Pendant la fenêtre, le même code reste valable pour plusieurs baisses de
// prix (voir discountValidUntil renvoyé par factures.js).
const bcrypt = require('bcryptjs');

let _cache = null;
let _cacheTs = 0;
const CACHE_TTL = 10 * 1000; // court : un code fraîchement généré doit être pris en compte vite

const DEFAULT_WINDOW_MINUTES = 5;

function invalidateCache() {
  _cache = null;
  _cacheTs = 0;
}

async function getOtpDoc() {
  if (_cache !== null && Date.now() - _cacheTs < CACHE_TTL) return _cache;
  const { db } = require('../firebase-admin');
  const doc = await db.collection('settings').doc('discountOtp').get();
  _cache = doc.exists ? doc.data() : null;
  _cacheTs = Date.now();
  return _cache;
}

async function getWindowMinutes() {
  const { db } = require('../firebase-admin');
  const doc = await db.collection('settings').doc('discountOtpConfig').get();
  const minutes = doc.exists ? Number(doc.data().windowMinutes) : NaN;
  return Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_WINDOW_MINUTES;
}

// Vérifie le code saisi par la caissière contre l'OTP actif. Retourne
// { valid, expiresAt } — expiresAt (ISO) permet au client de mémoriser la
// fenêtre en cours et de ne pas resaisir le code pour chaque article baissé.
async function verifyDiscountPin(pin) {
  if (!pin) return { valid: false };
  const otp = await getOtpDoc();
  if (!otp || !otp.codeHash || !otp.expiresAt) return { valid: false };
  if (new Date(otp.expiresAt).getTime() <= Date.now()) return { valid: false };
  const match = await bcrypt.compare(String(pin), otp.codeHash);
  return match ? { valid: true, expiresAt: otp.expiresAt } : { valid: false };
}

// Repère, parmi les articles soumis, ceux dont le prix est en dessous du prix
// catalogue actuel (menu). Les articles sans menuItemId (hors-carte) ne sont
// pas concernés faute de tarif de référence.
async function findDiscountedItems(db, items) {
  const withMenuId = (items || []).filter(i => i.menuItemId);
  if (withMenuId.length === 0) return [];

  const { FieldPath } = require('../firebase-admin');
  const ids = [...new Set(withMenuId.map(i => i.menuItemId))];
  const menuMap = {};
  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30);
    const snap = await db.collection('menu')
      .where(FieldPath.documentId(), 'in', chunk)
      .get();
    snap.docs.forEach(d => { menuMap[d.id] = d.data(); });
  }

  return withMenuId.filter(i => {
    const menuItem = menuMap[i.menuItemId];
    return menuItem && Number(i.prix) < Number(menuItem.prix);
  });
}

module.exports = {
  getOtpDoc, getWindowMinutes, verifyDiscountPin, invalidateCache, findDiscountedItems,
  DEFAULT_WINDOW_MINUTES,
};
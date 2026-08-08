// Code PIN admin requis pour qu'une caissière baisse le prix d'un article de
// facture sous son tarif catalogue (menu). Stocké haché (bcrypt) dans
// settings/discountPin, mis en cache en mémoire 5 minutes (même pattern que
// utils/wifi.js).
const bcrypt = require('bcryptjs');

let _cache = null;
let _cacheTs = 0;
const CACHE_TTL = 5 * 60 * 1000;

function invalidateCache() {
  _cache = null;
  _cacheTs = 0;
}

async function getPinHash() {
  if (_cache !== null && Date.now() - _cacheTs < CACHE_TTL) return _cache;
  const { db } = require('../firebase-admin');
  const doc = await db.collection('settings').doc('discountPin').get();
  _cache = doc.exists ? (doc.data().pinHash || null) : null;
  _cacheTs = Date.now();
  return _cache;
}

async function verifyDiscountPin(pin) {
  if (!pin) return false;
  const hash = await getPinHash();
  if (!hash) return false; // aucun PIN configuré → aucune baisse de prix autorisée
  return bcrypt.compare(String(pin), hash);
}

// Repère, parmi les articles soumis, ceux dont le prix est en dessous du prix
// catalogue actuel (menu). Les articles sans menuItemId (hors-carte) ne sont
// pas concernés faute de tarif de référence.
async function findDiscountedItems(db, items) {
  const withMenuId = (items || []).filter(i => i.menuItemId);
  if (withMenuId.length === 0) return [];

  const { admin } = require('../firebase-admin');
  const ids = [...new Set(withMenuId.map(i => i.menuItemId))];
  const menuMap = {};
  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30);
    const snap = await db.collection('menu')
      .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
      .get();
    snap.docs.forEach(d => { menuMap[d.id] = d.data(); });
  }

  return withMenuId.filter(i => {
    const menuItem = menuMap[i.menuItemId];
    return menuItem && Number(i.prix) < Number(menuItem.prix);
  });
}

module.exports = { getPinHash, verifyDiscountPin, invalidateCache, findDiscountedItems };
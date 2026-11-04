// Listes de commandes / factures par jour ou par période, partagées par les routes
// (commandes, factures, dashboard). Mises en cache sous `<collection>:list:<debut>[:<fin>]`
// et tenues à jour à chaque écriture (utils/cache.js#patchDoc) : elles ne sont relues dans
// Firestore qu'à l'expiration du cache, pas après chaque commande ou paiement.
const { db } = require('../firebase-admin');
const cache = require('./cache');

// Filet de sécurité seulement (les écritures faites par un AUTRE processus — AWS Lambda
// pendant que Render dormait — ne mettent pas à jour ce cache) : borne le retard possible.
const LISTE_TTL = 2 * 60_000;

function listeParPeriode(collection, debut, fin) {
  const key = debut === fin ? `${collection}:list:${debut}` : `${collection}:list:${debut}:${fin}`;
  return cache.remember(key, LISTE_TTL, async () => {
    // Un seul champ filtré (égalité ou plage sur `date`) : pas d'index composite requis.
    const q = debut === fin
      ? db.collection(collection).where('date', '==', debut)
      : db.collection(collection).where('date', '>=', debut).where('date', '<=', fin);
    const snap = await q.get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  });
}

// Menu complet, clé 'menu:list' partagée par GET /api/menu, le rapport et le menu public.
// Vidé à chaque écriture sur le menu (routes/menu.js) : le TTL ne couvre que les
// modifications faites par un autre processus (AWS Lambda), d'où une valeur large.
const MENU_TTL = 30 * 60_000;

function menuEnCache() {
  return cache.remember('menu:list', MENU_TTL, async () => {
    const snap = await db.collection('menu').orderBy('categorie').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  });
}

module.exports = { listeParPeriode, LISTE_TTL, menuEnCache };

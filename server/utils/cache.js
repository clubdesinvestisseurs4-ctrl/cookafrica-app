const _store = new Map();
const _inflight = new Map();

function get(key) {
  const e = _store.get(key);
  if (!e || Date.now() - e.ts > e.ttl) { _store.delete(key); return null; }
  return e.data;
}

function set(key, data, ttlMs) {
  _store.set(key, { data, ts: Date.now(), ttl: ttlMs });
}

function del(...keys) {
  keys.forEach(k => _store.delete(k));
}

// Pour les caches indexés par période (ex. `stats:bilan:<debut>:<fin>`) : une écriture
// peut toucher n'importe laquelle, on les vide toutes.
function delPrefix(prefix) {
  for (const key of _store.keys()) if (key.startsWith(prefix)) _store.delete(key);
}

// Lecture avec cache ET partage des requêtes en cours : quand plusieurs postes rechargent
// la même vue au même instant (un événement SSE arrive sur tous à la fois), un seul appel
// Firestore part ; les autres attendent son résultat au lieu de relire chacun les mêmes
// documents (mesuré le 2026-11-04 : c'était un multiplicateur direct du quota).
async function remember(key, ttlMs, loader) {
  const hit = get(key);
  if (hit) return hit;
  if (_inflight.has(key)) return _inflight.get(key);
  const p = (async () => {
    try {
      const data = await loader();
      set(key, data, ttlMs);
      return data;
    } finally {
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, p);
  return p;
}

// ─── Listes de documents tenues à jour à l'écriture ──────────────────────────
// Clés `<collection>:list` (les N plus récents), `<collection>:list:<jour>` et
// `<collection>:list:<debut>:<fin>`. Au lieu de jeter ces listes à chaque écriture (ce
// qui faisait relire toute la journée à chaque commande, paiement ou modification), la
// modification est appliquée directement dans la liste en mémoire — voir le branchement
// dans firebase-admin.js, qui appelle patchDoc après chaque écriture réussie.
function bornesCle(key, col) {
  const reste = key.slice(`${col}:list`.length);
  if (reste === '') return { recents: true };
  const [debut, fin] = reste.slice(1).split(':');
  return { debut, fin: fin || debut };
}

function doitContenir(bornes, doc) {
  if (bornes.recents) return true;
  return !!doc.date && doc.date >= bornes.debut && doc.date <= bornes.fin;
}

// `change` : { type: 'set', data } (document complet), { type: 'merge', data } (champs
// modifiés seulement) ou { type: 'delete' }.
function patchDoc(col, id, change) {
  const prefix = `${col}:list`;
  for (const [key, entry] of _store) {
    if (key !== prefix && !key.startsWith(`${prefix}:`)) continue;
    if (Date.now() - entry.ts > entry.ttl) { _store.delete(key); continue; }
    const liste = entry.data;
    const idx = liste.findIndex(d => d.id === id);

    if (change.type === 'delete') {
      if (idx >= 0) liste.splice(idx, 1);
      continue;
    }

    const bornes = bornesCle(key, col);
    let doc;
    if (change.type === 'set') {
      doc = { id, ...change.data };
    } else if (idx >= 0) {
      doc = { ...liste[idx], ...change.data };
    } else {
      // Mise à jour partielle d'un document absent de cette liste : on ne connaît pas le
      // document entier. S'il pourrait en faire partie (liste de période), on la jette
      // pour qu'elle soit relue ; une liste "récents" n'a pas à récupérer un vieux document.
      if (!bornes.recents && change.data.date && doitContenir(bornes, change.data)) _store.delete(key);
      continue;
    }

    const dedans = doitContenir(bornes, doc);
    if (idx >= 0 && dedans) liste[idx] = doc;
    else if (idx >= 0) liste.splice(idx, 1);
    else if (dedans) liste.unshift(doc);
  }
}

module.exports = { get, set, del, delPrefix, remember, patchDoc };

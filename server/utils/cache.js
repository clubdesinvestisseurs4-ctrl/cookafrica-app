const _store = new Map();

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

module.exports = { get, set, del, delPrefix };

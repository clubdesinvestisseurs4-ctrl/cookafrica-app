// Registre SSE : diffuse des événements légers à tous les clients connectés.
// Les clients reçoivent uniquement le TYPE de changement, pas les données —
// ils font ensuite leur propre appel API (qui tape le cache en mémoire).
const clients = new Set();

function addClient(res)    { clients.add(res); }
function removeClient(res) { clients.delete(res); }

function emit(type) {
  if (clients.size === 0) return;
  const msg = `data: ${JSON.stringify({ type })}\n\n`;
  for (const res of [...clients]) {
    try { res.write(msg); } catch { clients.delete(res); }
  }
}

module.exports = { addClient, removeClient, emit };

// Registre SSE : diffuse des événements légers à tous les clients connectés.
// Les clients reçoivent uniquement le TYPE de changement, pas les données —
// ils font ensuite leur propre appel API (qui tape le cache en mémoire).
const clients = new Set();
const pending = new Map(); // type -> timer

function addClient(res)    { clients.add(res); }
function removeClient(res) { clients.delete(res); }

function broadcast(type) {
  if (clients.size === 0) return;
  const msg = `data: ${JSON.stringify({ type })}\n\n`;
  for (const res of [...clients]) {
    try { res.write(msg); } catch { clients.delete(res); }
  }
}

// Regroupe les émissions rapprochées d'un même type (ex. plusieurs écritures
// 'commandes' en quelques secondes pendant un coup de feu — commande créée, envoyée en
// cuisine, payée) en une seule diffusion : sans ça, CHAQUE écriture faisait relire tout
// appareil connecté sur la page concernée, et le nombre de lectures Firestore grossissait
// avec écritures × appareils actifs, pile aux heures de repas (pics du 26/09). Le délai
// est imperceptible pour du personnel de restaurant, pas pour du temps réel financier.
const DEBOUNCE_MS = 1500;
function emit(type) {
  if (pending.has(type)) return; // déjà programmé, la diffusion à venir reflétera l'état actuel
  const timer = setTimeout(() => {
    pending.delete(type);
    broadcast(type);
  }, DEBOUNCE_MS);
  // Sur Lambda (voir IS_LAMBDA côté server.js), aucun client SSE n'est jamais ajouté —
  // unref() évite que ce minuteur en attente prolonge inutilement la facturation de
  // l'invocation (Lambda attend par défaut que la boucle d'événements soit vide).
  if (typeof timer.unref === 'function') timer.unref();
  pending.set(type, timer);
}

module.exports = { addClient, removeClient, emit };

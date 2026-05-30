// Version du SW — incrémenter à chaque déploiement pour forcer la mise à jour
const SW_VERSION = 'cookafrica-v2.0.0';

// ── Install : activation immédiate sans bloquer sur du pré-cache ──
self.addEventListener('install', () => {
  self.skipWaiting();
});

// ── Activate : supprime TOUS les anciens caches puis prend le contrôle ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Fetch : réseau direct pour tous les fichiers de l'app ──
// Les appels API passent en réseau avec fallback hors-ligne.
// Les assets (HTML, JS, CSS) ne sont JAMAIS mis en cache :
// l'utilisateur reçoit toujours la version en production.
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Appels API → réseau obligatoire, message offline si coupé
  if (
    url.pathname.startsWith('/api/') ||
    url.hostname.includes('render.com') ||
    url.hostname.includes('firestore.googleapis.com')
  ) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(
          JSON.stringify({ error: 'Hors ligne – vérifiez votre connexion' }),
          { headers: { 'Content-Type': 'application/json' }, status: 503 }
        )
      )
    );
    return;
  }

  // Tout le reste (HTML, JS, CSS, icônes…) → réseau direct, sans cache SW
  event.respondWith(fetch(event.request));
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

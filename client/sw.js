// Version du SW — incrémenter à chaque déploiement pour forcer la mise à jour
const SW_VERSION = 'cookafrica-v2.0.1';

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
  event.respondWith(
    fetch(event.request).catch(() => {
      if (event.request.mode === 'navigate') {
        return new Response(
          '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Hors ligne</title></head><body style="font-family:sans-serif;text-align:center;padding:2rem"><h1>Vous êtes hors ligne</h1><p>Vérifiez votre connexion et rechargez la page.</p></body></html>',
          { headers: { 'Content-Type': 'text/html' }, status: 503 }
        );
      }
      return new Response('', { status: 503 });
    })
  );
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

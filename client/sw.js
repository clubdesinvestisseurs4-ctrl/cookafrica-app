// Version du SW — incrémenter à chaque déploiement pour forcer la mise à jour
const SW_VERSION = 'cookafrica-v3.0.0';
const SHELL_CACHE = `cookafrica-shell-${SW_VERSION}`;

// App shell : ce qui ne change pas à chaque commande, précaché pour un premier
// démarrage 100% hors-ligne après une première visite en ligne.
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/logo-cookafrica.png',
  '/icons/icon-72.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css',
];

// ── Install : précache le shell (best-effort, une ressource en échec ne
// doit pas bloquer l'installation) puis activation immédiate ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => Promise.allSettled(
        SHELL_ASSETS.map(url => cache.add(url))
      ))
      .then(() => self.skipWaiting())
  );
});

// ── Activate : supprime les anciens caches shell puis prend le contrôle ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Fetch ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Appels API → laissés totalement passer au navigateur, sans respondWith().
  // Important : si on substitue une réponse 503 ici en cas d'échec réseau,
  // le fetch() de la page ne rejette jamais et la file d'attente hors-ligne
  // (client/app.js) ne peut pas détecter la coupure pour mettre en attente.
  if (
    url.pathname.startsWith('/api/') ||
    url.hostname.includes('render.com') ||
    url.hostname.includes('run.app') ||
    url.hostname.includes('firestore.googleapis.com')
  ) {
    return;
  }

  // Shell (HTML, JS, CSS, icônes…) → réseau d'abord (toujours la version
  // fraîche si connecté), avec mise à jour du cache en tâche de fond, et
  // fallback sur le cache si le réseau est indisponible.
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(SHELL_CACHE).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (event.request.mode === 'navigate') {
          const shell = await caches.match('/index.html');
          if (shell) return shell;
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

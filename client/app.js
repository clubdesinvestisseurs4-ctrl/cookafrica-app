// ══════════════════════════════════════════════════════
//  COOK AFRICA — Application de gestion restaurant
//  Vanilla JS (ES modules) + Express API + Firebase
// ══════════════════════════════════════════════════════

const API = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? 'http://localhost:3001'
  : 'https://cookafrica-api-667992371198.us-central1.run.app'; // Cloud Run (us-central1)

// Cloud Run peut redémarrer à froid après une période d'inactivité → ping /health avec backoff exponentiel
// Max 6 tentatives : ~4s, 6s, 9s, 14s, 20s = 6 requêtes sur ~55s
async function wakeUpServer() {
  if (API.includes('localhost')) return;
  const statusEl = document.getElementById('splash-status');
  const delays = [0, 4000, 6000, 9000, 14000, 20000];
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await new Promise(r => setTimeout(r, delays[i]));
    try {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 10000);
      const res  = await fetch(API + '/health', { signal: ctrl.signal });
      clearTimeout(tid);
      if (res.ok) { if (statusEl) statusEl.textContent = ''; return; }
    } catch { /* réseau ou timeout */ }
    if (statusEl) statusEl.textContent = 'Démarrage du serveur en cours… veuillez patienter';
  }
  if (statusEl) statusEl.textContent = '';
}

const state = {
  token:   null,
  user:    null,
  menu:    [],
  commandes: [],
  factures:  [],
  stocks:    [],
  utilisateurs: [],
  panier:    [],
  panierSource: 'sur-place',
  barFactures: {},
  notifInterval:       null,
  cuisineInterval:     null,
  dashInterval:        null,
  barmanInterval:      null,
  commandesInterval:   null,
  facturationInterval: null,
  wifiInterval:        null,
  eventSource:         null,
  sseConnected:        false,
  soundEnabled:        localStorage.getItem('ca_sound') === '1',
  cuisineKnownIds:     null,
  barKnownIds:         null,
  factureKnownIds:     null,
  voiceReminderInterval: null,
  editFactureItems:    [],
  editFactureCode:     '',
  editCommandeItems:   [],
  payFactureItems:     null,
};

// ─── Labels des rôles ─────────────────────────────────
const ROLE_LABELS = {
  admin:      'Administrateur',
  caissiere:  'Caissière',
  serveur:    'Serveur',
  cuisiniere: 'Cuisinière',
  barman:     'Barman',
};

// ─── Visibilité des pages par rôle ────────────────────
const PAGE_ROLES = {
  dashboard:      ['admin', 'caissiere', 'serveur', 'cuisiniere', 'barman'],
  commandes:      ['admin', 'serveur'],
  'commandes-en-ligne': ['admin', 'caissiere'],
  cuisine:        ['admin', 'cuisiniere'],
  facturation:    ['admin', 'caissiere'],
  menu:           ['admin'],
  stocks:         ['admin'],
  rapports:       ['admin'],
  sessions:       ['admin'],
  barman:         ['admin', 'barman'],
  utilisateurs:   ['admin'],
};

const PAGE_TITLES = {
  dashboard:      'Dashboard',
  commandes:      'Commandes',
  'commandes-en-ligne': 'Commandes en Ligne',
  cuisine:        'Écran Cuisine',
  facturation:    'Facturation',
  menu:           'Carte du Menu',
  stocks:         'Gestion des Stocks',
  rapports:       'Rapports & Statistiques',
  sessions:       'Journal des Sessions',
  barman:         'Écran Bar',
  utilisateurs:   'Gestion des Utilisateurs',
};

// ─── Utilitaires ──────────────────────────────────────

// ─── File d'attente hors-ligne (Phase 1) ──────────────
// Si une requête de modification (POST/PUT/DELETE) ne peut pas joindre le
// serveur (réseau coupé), on la stocke en local au lieu de la perdre, et on
// la rejoue automatiquement dès que la connexion revient. Les GET ne sont
// jamais mis en file : ils n'ont rien à "rejouer", juste à réessayer plus tard.
const OFFLINE_QUEUE_KEY = 'ca_offline_queue';

function getOfflineQueue() {
  try { return JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || '[]'); }
  catch { return []; }
}

function setOfflineQueue(queue) {
  localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
  updateOfflineBadge();
}

function queueOfflineRequest(method, path, body) {
  const queue = getOfflineQueue();
  queue.push({
    id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
    method, path, body,
    createdAt: new Date().toISOString(),
  });
  setOfflineQueue(queue);
}

function updateOfflineBadge() {
  const badge = document.getElementById('offline-queue-badge');
  if (!badge) return;
  const n = getOfflineQueue().length;
  badge.style.display = n > 0 ? 'inline-flex' : 'none';
  badge.innerHTML = `<i class="fas fa-cloud-upload-alt"></i> ${n} en attente de synchro`;
}

let flushingOfflineQueue = false;
async function flushOfflineQueue() {
  if (flushingOfflineQueue || !state.token) return;
  flushingOfflineQueue = true;
  try {
    let queue = getOfflineQueue();
    let synced = 0;
    while (queue.length > 0) {
      const item = queue[0];
      let res;
      try {
        const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` };
        res = await fetch(API + item.path, {
          method: item.method,
          headers,
          body: item.body !== null && item.body !== undefined ? JSON.stringify(item.body) : undefined,
        });
      } catch {
        break; // toujours hors-ligne — on réessaiera au prochain tick
      }
      queue.shift();
      setOfflineQueue(queue);
      if (res.ok) synced++;
      else toast('Une action en attente a été refusée par le serveur (ignorée)', 'warning');
      queue = getOfflineQueue();
    }
    if (synced > 0) {
      toast(`${synced} action(s) hors-ligne synchronisée(s)`, 'success');
      handleSSEEvent('commandes'); // rafraîchit l'écran courant avec les données à jour
    }
  } finally {
    flushingOfflineQueue = false;
  }
}

window.addEventListener('online', flushOfflineQueue);
setInterval(flushOfflineQueue, 30_000);

async function api(path, opts = {}, _retry = false) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(API + path, { signal: controller.signal, headers, ...opts });
    clearTimeout(tid);
    if (res.status === 401) { logout(); return null; }
    if (res.status === 403) {
      try {
        const body = await res.json();
        if (body.error === 'wifi_restricted') { wifiLogout(); return null; }
      } catch {}
      return null;
    }
    if (res.status === 503 && !_retry) {
      await wakeUpServer();
      return api(path, opts, true);
    }
    if (res.status === 429) {
      toast('Trop de requêtes envoyées — patientez quelques secondes', 'warning');
      return null;
    }
    if (!res.ok) return null;
    return res.json();
  } catch {
    const method = (opts.method || 'GET').toUpperCase();
    if (method !== 'GET') {
      let body = null;
      try { body = opts.body ? JSON.parse(opts.body) : null; } catch {}
      queueOfflineRequest(method, path, body);
      toast('Pas de connexion — action enregistrée, elle sera synchronisée automatiquement', 'warning');
      return { queued: true };
    }
    return null;
  }
}

function fmt(n)   { return Number(n || 0).toLocaleString('fr-FR'); }
function fmtDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
  } catch { return iso; }
}
function fmtDateOnly(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''));
    return d.toLocaleDateString('fr-FR');
  } catch { return iso; }
}
function today() { return new Date().toISOString().split('T')[0]; }

function showLoader()  { document.getElementById('loader').classList.remove('hidden'); }
function hideLoader()  { document.getElementById('loader').classList.add('hidden'); }

function hideSplash() {
  return new Promise(resolve => {
    const el = document.getElementById('splash-screen');
    if (!el || el.classList.contains('hidden')) { resolve(); return; }
    el.classList.add('spl-out');
    setTimeout(() => { el.classList.add('hidden'); resolve(); }, 720);
  });
}

function showWelcomeTransition(user) {
  return new Promise(resolve => {
    const el = document.getElementById('welcome-transition');
    document.getElementById('wt-name').textContent = user.nom;
    document.getElementById('wt-role').textContent = ROLE_LABELS[user.role] || user.role;
    el.style.display = 'flex'; // écrase le style inline display:none
    el.classList.remove('wt-hide');
    el.classList.add('wt-show');
    setTimeout(() => {
      document.getElementById('login-screen').style.display = 'none';
      document.getElementById('app-screen').style.display   = 'flex';
      el.classList.remove('wt-show');
      el.classList.add('wt-hide');
      setTimeout(() => {
        el.classList.remove('wt-hide');
        el.style.display = 'none';
        resolve();
      }, 650);
    }, 1950);
  });
}

// Échappe le HTML pour éviter les injections XSS via des champs saisis par les utilisateurs
// (note, tableNumero, etc.) avant insertion dans innerHTML.
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Annonces vocales (nouvelles commandes) ───────────
function itemsSummary(items) {
  return (items || []).map(i => `${i.quantite} ${i.nom}`).join(', ');
}

function speak(text) {
  if (state.user?.role === 'admin') return; // sons désactivés côté admin
  if (!state.soundEnabled || !('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'fr-FR';
    u.rate = 0.95;
    window.speechSynthesis.speak(u);
  } catch {}
}

function updateSoundButtons() {
  // Sons désactivés côté admin — on masque aussi les commandes devenues inertes
  const soundIds = [
    'btn-sound-cuisine', 'btn-play-cuisine',
    'btn-sound-barman', 'btn-play-barman',
    'btn-sound-facturation', 'btn-play-facturation',
  ];
  if (state.user?.role === 'admin') {
    soundIds.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
    return;
  }
  soundIds.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = ''; });

  const cuisineBtn = document.getElementById('btn-sound-cuisine');
  const barBtn      = document.getElementById('btn-sound-barman');
  const factBtn     = document.getElementById('btn-sound-facturation');
  if (cuisineBtn) {
    cuisineBtn.classList.toggle('btn-success', state.soundEnabled);
    cuisineBtn.classList.toggle('btn-warning', !state.soundEnabled);
    cuisineBtn.innerHTML = state.soundEnabled
      ? '<i class="fas fa-volume-up"></i> Son activé'
      : '<i class="fas fa-volume-mute"></i> Activer le son';
  }
  if (barBtn) {
    barBtn.classList.toggle('btn-success', state.soundEnabled);
    barBtn.classList.toggle('btn-bar', !state.soundEnabled);
    barBtn.innerHTML = state.soundEnabled
      ? '<i class="fas fa-volume-up"></i> Son activé'
      : '<i class="fas fa-volume-mute"></i> Activer le son';
  }
  if (factBtn) {
    factBtn.classList.toggle('btn-success', state.soundEnabled);
    factBtn.classList.toggle('btn-accent', !state.soundEnabled);
    factBtn.innerHTML = state.soundEnabled
      ? '<i class="fas fa-volume-up"></i> Son activé'
      : '<i class="fas fa-volume-mute"></i> Activer le son';
  }
}

function enableSound(screen, announce = true) {
  state.soundEnabled = true;
  localStorage.setItem('ca_sound', '1');
  updateSoundButtons();
  if (!announce) return;
  const messages = { bar: 'Son activé pour le bar', facturation: 'Son activé pour la facturation' };
  speak(messages[screen] || 'Son activé pour la cuisine');
}

function toast(msg, type = 'info') {
  const icons = { success: 'check-circle', error: 'times-circle', warning: 'exclamation-triangle', info: 'info-circle' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<i class="fas fa-${icons[type] || 'info-circle'}"></i>${msg}`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function badgeStatus(statut) {
  const labels = {
    'en-attente':    '⏳ En attente',
    'en-preparation':'🔥 En préparation',
    'prete':         '✅ Prête',
    'servie':        '🍽️ Servie',
    'annulee':       '❌ Annulée',
    'payee':         '✅ Payée',
    'partielle':     '⚠️ Partielle',
  };
  return `<span class="badge-status ${statut}">${labels[statut] || statut}</span>`;
}

// ─── Auth ──────────────────────────────────────────────

function showLogoutTransition() {
  return new Promise(resolve => {
    const el = document.getElementById('logout-transition');
    document.getElementById('lt-name').textContent = state.user?.nom ?? '';
    el.style.opacity = '0';
    el.style.display = 'flex';
    el.style.transition = 'opacity .32s ease';
    void el.offsetWidth; // force reflow pour déclencher la transition CSS
    el.style.opacity = '1';
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => {
        el.style.display = 'none';
        el.style.transition = '';
        resolve();
      }, 380);
    }, 950);
  });
}

async function logout(animate = false) {
  if (animate) await showLogoutTransition();
  if (state.token) api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  state.token = null; state.user = null;
  localStorage.removeItem('ca_token');
  localStorage.removeItem('ca_user');
  clearIntervals();
  document.getElementById('app-screen').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
}

function wifiLogout() {
  toast('Vous n\'êtes plus sur le Wi-Fi de l\'entreprise. Déconnexion automatique.', 'warning');
  state.token = null; state.user = null;
  localStorage.removeItem('ca_token');
  localStorage.removeItem('ca_user');
  clearIntervals();
  document.getElementById('app-screen').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
}

async function checkWifi() {
  if (!state.token || state.user?.role === 'admin') return;
  await api('/api/auth/check-wifi');
  // Si hors Wi-Fi, api() détecte le 403 wifi_restricted et appelle wifiLogout().
}

function clearIntervals() {
  clearInterval(state.notifInterval);
  clearInterval(state.cuisineInterval);
  clearInterval(state.dashInterval);
  clearInterval(state.barmanInterval);
  clearInterval(state.commandesInterval);
  clearInterval(state.facturationInterval);
  clearInterval(state.wifiInterval);
  if (state.eventSource) { state.eventSource.close(); state.eventSource = null; }
  state.sseConnected = false;
}

async function loginFlow(token, user, skipWelcome = false) {
  state.token = token;
  state.user  = user;
  localStorage.setItem('ca_token', token);
  localStorage.setItem('ca_user', JSON.stringify(user));

  document.getElementById('sidebar-user-name').textContent = user.nom;
  document.getElementById('sidebar-user-role').textContent = ROLE_LABELS[user.role] || user.role;
  applyRoleNav();
  updateSoundButtons();
  updateOfflineBadge();
  flushOfflineQueue();
  navigateTo(defaultPage());
  startPolling();

  if (skipWelcome) {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app-screen').style.display   = 'flex';
  } else {
    await showWelcomeTransition(user);
  }
  hideLoader();
}

function defaultPage() {
  const role = state.user?.role;
  if (role === 'cuisiniere') return 'cuisine';
  if (role === 'barman')     return 'barman';
  if (role === 'serveur')    return 'commandes';
  if (role === 'caissiere')  return 'facturation';
  return 'dashboard'; // admin
}

function applyRoleNav() {
  const role = state.user?.role;
  document.querySelectorAll('.nav-item[data-page]').forEach(el => {
    const page = el.dataset.page;
    const allowed = PAGE_ROLES[page] || [];
    el.style.display = allowed.includes(role) ? 'flex' : 'none';
  });
  // Cacher les labels de section si tous les items sont masqués
  const sections = document.querySelectorAll('.nav-section-label');
  sections.forEach(label => {
    let next = label.nextElementSibling;
    let hasVisible = false;
    while (next && !next.classList.contains('nav-section-label')) {
      if (next.style.display !== 'none') hasVisible = true;
      next = next.nextElementSibling;
    }
    label.style.display = hasVisible ? 'block' : 'none';
  });
}

// ─── Navigation ────────────────────────────────────────

function navigateTo(page) {
  if (!PAGE_ROLES[page]?.includes(state.user?.role)) return;

  document.querySelectorAll('.page').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(a => a.classList.remove('active'));

  const section = document.getElementById(`page-${page}`);
  if (section) section.classList.add('active');

  const navItem = document.querySelector(`.nav-item[data-page="${page}"]`);
  if (navItem) navItem.classList.add('active');

  document.getElementById('page-title').textContent = PAGE_TITLES[page] || page;
  state.currentPage = page;

  const loaders = {
    dashboard:    loadDashboard,
    commandes:    loadCommandes,
    'commandes-en-ligne': loadCommandesLigne,
    cuisine:      () => loadCuisine(true),
    facturation:  () => { loadFactures(); checkFacturationReady(true); },
    menu:         loadMenu,
    stocks:       loadStocks,
    rapports:     () => {},
    sessions:     loadSessions,
    barman:       () => loadBarman(true),
    utilisateurs: () => { loadUtilisateurs(); loadWifiConfig(); },
  };
  if (loaders[page]) loaders[page]();
}

// ─── Date header ───────────────────────────────────────

function updateDateBadge() {
  const el = document.getElementById('header-date');
  el.textContent = new Date().toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
}

// ─── Temps réel : SSE + fallback polling ───────────────

// Appelé à chaque événement SSE reçu du serveur.
// Le serveur envoie uniquement le type (ex. "commandes") — jamais de données brutes.
// Le client rafraîchit sa page courante en appelant l'API (qui tape le cache en mémoire).
function handleSSEEvent(type) {
  const page = state.currentPage;
  if (!page) return;

  if (type === '_reconnect') {
    // Reconnexion après coupure — resynchroniser la page courante
    const reloaders = {
      cuisine:     loadCuisine,
      barman:      loadBarman,
      commandes:   loadCommandes,
      'commandes-en-ligne': loadCommandesLigne,
      facturation: loadFactures,
      dashboard:   loadDashboard,
      stocks:      loadStocks,
    };
    reloaders[page]?.();
    return;
  }

  if (type === 'commandes') {
    if      (page === 'cuisine')     loadCuisine();
    else if (page === 'barman')      loadBarman();
    else if (page === 'commandes')   loadCommandes();
    else if (page === 'commandes-en-ligne') loadCommandesLigne();
    else if (page === 'facturation') { loadFactures(); checkFacturationReady(); }
    else if (page === 'dashboard')   loadDashboard();
  }
  if (type === 'factures') {
    if      (page === 'facturation') { loadFactures(); checkFacturationReady(); }
    else if (page === 'dashboard')   loadDashboard();
  }
  if (type === 'stocks') {
    if (page === 'stocks') loadStocks();
  }
  if (type === 'notifications' && state.user?.role === 'admin') {
    loadNotifBadge();
  }
}

function startEventSource() {
  if (!state.token || state.eventSource) return;
  const es = new EventSource(`${API}/api/events?token=${encodeURIComponent(state.token)}`);
  state.eventSource = es;

  es.onmessage = (e) => {
    try {
      const { type } = JSON.parse(e.data);
      if (type === 'connected') {
        if (state.sseConnected) handleSSEEvent('_reconnect'); // reconnexion
        state.sseConnected = true;
        return;
      }
      handleSSEEvent(type);
    } catch {}
  };

  es.onerror = () => { state.sseConnected = false; };
  // EventSource se reconnecte automatiquement — pas besoin de logique manuelle
}

function startPolling() {
  const role = state.user?.role;
  updateDateBadge();
  setInterval(updateDateBadge, 60_000);

  // Démarrer la connexion SSE temps réel (tous les rôles)
  startEventSource();

  // ── Fallback polling — ne se déclenche VRAIMENT que si le SSE est down ──
  // (state.sseConnected === false). Tant que le temps réel fonctionne, ces
  // intervalles ne font rien : évite de doubler chaque mise à jour SSE avec
  // une requête HTTP inutile toutes les 30 s sur chaque poste ouvert.
  const POLL_MS = 45_000;

  state.dashInterval = setInterval(() => {
    if (!state.sseConnected && state.currentPage === 'dashboard') loadDashboard();
  }, POLL_MS);

  if (role === 'admin' || role === 'cuisiniere') {
    state.cuisineInterval = setInterval(() => {
      if (!state.sseConnected && state.currentPage === 'cuisine') loadCuisine();
    }, POLL_MS);
  }

  if (role === 'admin' || role === 'barman') {
    state.barmanInterval = setInterval(() => {
      if (!state.sseConnected && state.currentPage === 'barman') loadBarman();
    }, POLL_MS);
  }

  // Serveur — actualisation commandes (secours si SSE down)
  if (role === 'admin' || role === 'serveur') {
    state.commandesInterval = setInterval(() => {
      if (!state.sseConnected && state.currentPage === 'commandes') loadCommandes();
    }, POLL_MS);
  }

  // Caissière — actualisation facturation + commandes en ligne (secours si SSE down)
  if (role === 'admin' || role === 'caissiere') {
    state.facturationInterval = setInterval(() => {
      if (state.sseConnected) return;
      if      (state.currentPage === 'facturation')        loadFactures();
      else if (state.currentPage === 'commandes-en-ligne')  loadCommandesLigne();
    }, POLL_MS);
  }

  // Rappel vocal périodique (toutes les 4 min) — relit l'état de l'écran actif si le son est activé
  state.voiceReminderInterval = setInterval(() => {
    if (!state.soundEnabled) return;
    if      (state.currentPage === 'cuisine')     loadCuisine(true);
    else if (state.currentPage === 'barman')      loadBarman(true);
    else if (state.currentPage === 'facturation') checkFacturationReady(true);
  }, 4 * 60_000);

  // Notifications — admin seulement
  if (role === 'admin') {
    loadNotifBadge();
    state.notifInterval = setInterval(loadNotifBadge, 60_000);
  }

  // Vérification Wi-Fi — non-admin seulement (admin peut se connecter depuis n'importe où)
  if (role !== 'admin') {
    state.wifiInterval = setInterval(checkWifi, 30_000);
  }
}

// ─── DASHBOARD ─────────────────────────────────────────

async function loadDashboard() {
  const data = await api('/api/stats/dashboard');
  if (!data) return;

  document.getElementById('stat-commandes-jour').textContent    = data.commandesJour ?? '—';
  document.getElementById('stat-commandes-actives').textContent = data.commandesActives ?? '—';
  document.getElementById('stat-revenus-jour').textContent      = fmt(data.revenusJour);
  document.getElementById('stat-alertes').textContent           = data.alertesStock ?? '—';

  // Commandes actives
  const actives = document.getElementById('dash-commandes-actives');
  if (!data.commandesRecentes || data.commandesRecentes.length === 0) {
    actives.innerHTML = '<div class="empty-state"><i class="fas fa-check-circle"></i><p>Aucune commande en cours</p></div>';
  } else {
    actives.innerHTML = data.commandesRecentes.map(c => `
      <div class="list-item">
        <div>
          <strong>${c.numero}</strong>
          ${c.tableNumero ? `<span style="color:var(--gray);font-size:.78rem"> – ${escapeHtml(c.tableNumero)}</span>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:.78rem;color:var(--gray)">${fmt(c.total)} FCFA</span>
          ${badgeStatus(c.statut)}
        </div>
      </div>`).join('');
  }

  // Activité
  const activite = document.getElementById('dash-activite');
  const parStatut = data.commandesParStatut || {};
  activite.innerHTML = `
    <div class="list-item"><span>🟡 En attente</span><strong>${parStatut['en-attente'] || 0}</strong></div>
    <div class="list-item"><span>🔵 En préparation</span><strong>${parStatut['en-preparation'] || 0}</strong></div>
    <div class="list-item"><span>🟢 Prêtes</span><strong>${parStatut['prete'] || 0}</strong></div>
    <div class="list-item"><span>✅ Servies aujourd'hui</span><strong>${parStatut['servie'] || 0}</strong></div>
  `;

  // Stock alerts
  const stockAlerts = document.getElementById('dash-stock-alerts');
  const alerts = await api('/api/stocks/alerts');
  if (!alerts || alerts.length === 0) {
    stockAlerts.innerHTML = '<p style="color:var(--success);font-size:.85rem"><i class="fas fa-check"></i> Stocks OK</p>';
  } else {
    stockAlerts.innerHTML = alerts.map(s => `
      <div class="alert-item">
        <i class="fas fa-exclamation-triangle"></i>
        <span>${s.nom} : ${s.quantite} / ${s.minimum} ${s.unite}</span>
      </div>`).join('');
  }
}

// ─── COMMANDES ─────────────────────────────────────────

async function loadCommandes() {
  const statut = document.getElementById('filter-cmd-statut')?.value || '';
  const date   = document.getElementById('filter-cmd-date')?.value   || '';
  let url = '/api/commandes?';
  if (statut) url += `statut=${statut}&`;
  if (date)   url += `date=${date}`;

  const [commandes, factures] = await Promise.all([api(url), api('/api/factures')]);
  if (!commandes) return;
  state.commandes = commandes;
  if (factures) state.factures = factures;

  const tbody = document.getElementById('commandes-tbody');
  if (commandes.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state" style="padding:32px"><i class="fas fa-list-alt"></i><p>Aucune commande</p></td></tr>';
    return;
  }

  tbody.innerHTML = commandes.map(c => {
    const items = (c.items || []).map(i => `${i.quantite}x ${escapeHtml(i.nom)}`).join(', ');
    const alreadyFactured = state.factures.some(f => f.commandeId === c.id);
    const hasBoissons = (c.items || []).some(i => i.categorie === 'Boissons');
    const hasPlats    = (c.items || []).some(i => i.categorie !== 'Boissons' && i.categorie !== 'Buffet');
    const kitchenOk   = !hasPlats || ['prete', 'servie'].includes(c.statut);
    const barOk       = !hasBoissons || c.boissonsStatut === 'prete';
    const canFacture  = kitchenOk && barOk && !alreadyFactured && state.user?.role !== 'serveur';
    const canCancel  = state.user?.role === 'admin' && !['annulee', 'servie'].includes(c.statut);
    const canEdit    = !alreadyFactured && !['annulee', 'servie'].includes(c.statut);
    const boissonsInfo = c.boissonsStatut === 'en-attente'
      ? '<br><small style="color:#1565C0;font-size:.72rem"><i class="fas fa-wine-glass-alt"></i> Boissons en attente</small>'
      : c.boissonsStatut === 'prete'
      ? '<br><small style="color:var(--success);font-size:.72rem"><i class="fas fa-check"></i> Boissons prêtes</small>'
      : '';
    return `
    <tr>
      <td data-label="N°"><strong>${c.numero}</strong>${c.source === 'en-ligne' ? ' <span style="background:#E3F2FD;color:#0d47a1;border:1px solid #90CAF9;border-radius:12px;padding:1px 7px;font-size:.68rem;font-weight:600"><i class="fas fa-globe"></i> En ligne</span>' : ''}</td>
      <td data-label="Date" style="font-size:.78rem;color:var(--gray)">${fmtDate(c.createdAt)}</td>
      <td data-label="Articles" style="font-size:.82rem">${items}</td>
      <td data-label="Total"><strong>${fmt(c.total)} FCFA</strong></td>
      <td data-label="Table" style="color:var(--gray);font-size:.82rem">${escapeHtml(c.tableNumero) || '—'}</td>
      <td data-label="Statut">${badgeStatus(c.statut)}${boissonsInfo}</td>
      <td data-label="Actions">
        <button class="btn btn-secondary btn-sm" onclick="viewCommande('${c.id}')">
          <i class="fas fa-eye"></i>
        </button>
        ${canEdit ? `<button class="btn btn-secondary btn-sm" onclick="openEditCommande('${c.id}')" title="Modifier la commande">
          <i class="fas fa-edit"></i>
        </button>` : ''}
        ${canFacture ? `<button class="btn btn-accent btn-sm" onclick="openNewFactureForCmd('${c.id}')">
          <i class="fas fa-receipt"></i> Facturer
        </button>` : ''}
        ${canCancel ? `<button class="btn btn-danger btn-sm" onclick="annulerCommande('${c.id}','${c.numero}')">
          <i class="fas fa-times"></i>
        </button>` : ''}
      </td>
    </tr>`;
  }).join('');
}

async function viewCommande(id) {
  const c = state.commandes.find(x => x.id === id);
  if (!c) return;

  const items = (c.items || []).map(i => `
    <div class="commande-item">
      <span><span class="commande-item-qty">${i.quantite}</span> ${escapeHtml(i.nom)}</span>
      <span>${fmt(i.sousTotal)} FCFA</span>
    </div>`).join('');

  document.getElementById('modal-detail-titre').textContent = `Commande ${c.numero}`;
  document.getElementById('modal-detail-body').innerHTML = `
    <div style="margin-bottom:12px">
      ${c.tableNumero ? `<p><strong>Table :</strong> ${escapeHtml(c.tableNumero)}</p>` : ''}
      ${c.note ? `<p style="color:var(--gray);font-size:.85rem;font-style:italic"><i class="fas fa-sticky-note"></i> ${escapeHtml(c.note)}</p>` : ''}
      <p><strong>Statut :</strong> ${badgeStatus(c.statut)}</p>
      <p style="font-size:.8rem;color:var(--gray)"><strong>Créée par :</strong> ${escapeHtml(c.createdBy)} – ${fmtDate(c.createdAt)}</p>
    </div>
    <div style="margin-bottom:12px">${items}</div>
    <div style="text-align:right;font-size:1.1rem;font-weight:800;color:var(--primary)">
      Total : ${fmt(c.total)} FCFA
    </div>`;
  openModal('detail-commande');
}

async function annulerCommande(id, numero) {
  if (!confirm(`Annuler la commande ${numero} ?`)) return;
  const res = await api(`/api/commandes/${id}`, { method: 'DELETE' });
  if (res?.message) { toast('Commande annulée', 'warning'); loadCommandes(); }
}

// ─── Modification libre d'une commande (serveur, avant facturation) ───

window.openEditCommande = async (id) => {
  const c = state.commandes.find(x => x.id === id);
  if (!c) return;

  document.getElementById('editcmd-id').value = id;
  document.getElementById('editcmd-numero').textContent = c.numero;
  state.editCommandeItems = (c.items || []).map(i => ({ ...i }));

  if (state.menu.length === 0) {
    const menu = await api('/api/menu');
    if (menu) state.menu = menu;
  }
  const select = document.getElementById('editcmd-add-select');
  select.innerHTML = '<option value="">+ Ajouter un article…</option>' +
    state.menu.filter(m => m.disponible).map(m =>
      `<option value="${m.id}" data-nom="${m.nom}" data-prix="${m.prix}" data-cat="${m.categorie || ''}">${m.nom} — ${fmt(m.prix)} FCFA</option>`
    ).join('');

  renderEditCommandeItems();
  openModal('edit-commande');
};

function renderEditCommandeItems() {
  const container = document.getElementById('editcmd-items');
  if (state.editCommandeItems.length === 0) {
    container.innerHTML = '<p style="color:var(--gray);font-size:.85rem;text-align:center;padding:12px">Aucun article</p>';
  } else {
    container.innerHTML = state.editCommandeItems.map((item, i) => `
      <div class="panier-item">
        <input class="panier-qty" type="number" min="1" max="99" value="${item.quantite}"
          onchange="updateEditCommandeQty(${i}, this.value)">
        <span class="panier-item-nom">${escapeHtml(item.nom)}</span>
        <span class="panier-item-prix">${fmt(item.sousTotal)} FCFA</span>
        <button class="panier-item-remove" onclick="removeEditCommandeItem(${i})">
          <i class="fas fa-trash"></i>
        </button>
      </div>`).join('');
  }
  const total = state.editCommandeItems.reduce((s, i) => s + i.sousTotal, 0);
  document.getElementById('editcmd-total').textContent = `Total : ${fmt(total)} FCFA`;
}

window.updateEditCommandeQty = (i, qty) => {
  const q = Math.max(1, parseInt(qty, 10) || 1);
  state.editCommandeItems[i].quantite = q;
  state.editCommandeItems[i].sousTotal = state.editCommandeItems[i].prix * q;
  renderEditCommandeItems();
};

window.removeEditCommandeItem = (i) => {
  state.editCommandeItems.splice(i, 1);
  renderEditCommandeItems();
};

function addToEditCommande(id, nom, prix, categorie) {
  const existing = state.editCommandeItems.find(p => p.menuItemId === id);
  if (existing) { existing.quantite++; existing.sousTotal = existing.prix * existing.quantite; }
  else { state.editCommandeItems.push({ menuItemId: id, nom, prix, categorie: categorie || '', quantite: 1, sousTotal: prix }); }
  renderEditCommandeItems();
}

async function saveEditCommande() {
  if (state.editCommandeItems.length === 0) { toast('La commande doit contenir au moins un article', 'warning'); return; }
  const id = document.getElementById('editcmd-id').value;

  showLoader();
  const res = await api(`/api/commandes/${id}/items`, {
    method: 'PUT',
    body: JSON.stringify({ items: state.editCommandeItems }),
  });
  hideLoader();

  if (!res?.id) { toast(res?.error || 'Erreur lors de la modification', 'error'); return; }
  toast('Commande modifiée', 'success');
  closeModal('edit-commande');
  if (state.currentPage === 'commandes-en-ligne') loadCommandesLigne(); else loadCommandes();
}

window.viewCommande = viewCommande;
window.annulerCommande = annulerCommande;

// ─── NOUVELLE COMMANDE (panier) ────────────────────────

async function openNewCommande(source = 'sur-place') {
  if (state.menu.length === 0) {
    const menu = await api('/api/menu');
    if (menu) state.menu = menu;
  }
  state.panier = [];
  state.panierSource = source;
  renderPanier();
  const search = document.getElementById('cmd-menu-search');
  search.value = '';
  document.getElementById('cmd-menu-clear').style.display = 'none';
  document.getElementById('menu-search-dropdown').style.display = 'none';
  document.getElementById('modal-commande-title').textContent =
    source === 'en-ligne' ? 'Nouvelle commande en ligne' : 'Nouvelle commande';
  openModal('commande');
}

function addToPanier(id, nom, prix, categorie) {
  const existing = state.panier.find(p => p.menuItemId === id);
  if (existing) { existing.quantite++; existing.sousTotal = existing.prix * existing.quantite; }
  else { state.panier.push({ menuItemId: id, nom, prix, categorie: categorie || '', quantite: 1, sousTotal: prix }); }
  renderPanier();
}

function renderMenuDropdown(query) {
  const dropdown  = document.getElementById('menu-search-dropdown');
  const menuDispo = state.menu.filter(m => m.disponible);
  const q = query.toLowerCase();
  const filtered  = q ? menuDispo.filter(m => m.nom.toLowerCase().includes(q)) : menuDispo;

  if (!filtered.length) {
    dropdown.innerHTML = '<div class="menu-search-empty"><i class="fas fa-search"></i> Aucun résultat</div>';
    dropdown.style.display = 'block';
    return;
  }

  const cats = [...new Set(filtered.map(m => m.categorie).filter(Boolean))].sort();
  let html = '';
  cats.forEach(cat => {
    const items = filtered.filter(m => m.categorie === cat);
    if (!items.length) return;
    html += `<div class="menu-search-cat">${cat}</div>`;
    items.forEach(m => {
      html += `<div class="menu-search-item" data-id="${m.id}" data-nom="${m.nom}" data-prix="${m.prix}" data-cat="${m.categorie || ''}">
        <span class="menu-search-item-nom">${hlSearch(m.nom, q)}</span>
        <span class="menu-search-item-prix">${fmt(m.prix)} FCFA</span>
      </div>`;
    });
  });
  filtered.filter(m => !m.categorie).forEach(m => {
    html += `<div class="menu-search-item" data-id="${m.id}" data-nom="${m.nom}" data-prix="${m.prix}" data-cat="">
      <span class="menu-search-item-nom">${hlSearch(m.nom, q)}</span>
      <span class="menu-search-item-prix">${fmt(m.prix)} FCFA</span>
    </div>`;
  });

  dropdown.innerHTML = html;
  dropdown.style.display = 'block';

  dropdown.querySelectorAll('.menu-search-item').forEach(el => {
    el.addEventListener('click', () => {
      addToPanier(el.dataset.id, el.dataset.nom, Number(el.dataset.prix), el.dataset.cat);
      document.getElementById('cmd-menu-search').value = '';
      document.getElementById('cmd-menu-clear').style.display = 'none';
      dropdown.style.display = 'none';
    });
  });
}

function hlSearch(text, query) {
  if (!query) return text;
  return text.replace(
    new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'),
    '<mark class="search-hl">$1</mark>'
  );
}

function renderPanier() {
  const container = document.getElementById('panier-items');
  const totalEl   = document.getElementById('panier-total');
  const totalVal  = document.getElementById('panier-total-val');

  if (state.panier.length === 0) {
    container.innerHTML = '<p style="color:var(--gray);font-size:.85rem;text-align:center;padding:12px">Aucun article</p>';
    totalEl.style.display = 'none';
    return;
  }

  container.innerHTML = state.panier.map((item, i) => `
    <div class="panier-item">
      <input class="panier-qty" type="number" min="1" max="99" value="${item.quantite}"
        onchange="updatePanierQty(${i}, this.value)">
      <span class="panier-item-nom">${item.nom}</span>
      <span class="panier-item-prix">${fmt(item.sousTotal)} FCFA</span>
      <button class="panier-item-remove" onclick="removePanierItem(${i})">
        <i class="fas fa-trash"></i>
      </button>
    </div>`).join('');

  const total = state.panier.reduce((s, p) => s + p.sousTotal, 0);
  totalEl.style.display = 'flex';
  totalVal.textContent  = `${fmt(total)} FCFA`;
}

window.updatePanierQty = (i, val) => {
  const qty = Math.max(1, parseInt(val) || 1);
  state.panier[i].quantite = qty;
  state.panier[i].sousTotal = state.panier[i].prix * qty;
  renderPanier();
};

window.removePanierItem = (i) => {
  state.panier.splice(i, 1);
  renderPanier();
};

async function saveCommande() {
  if (state.panier.length === 0) { toast('Ajoutez au moins un article', 'warning'); return; }
  const isOnline = state.panierSource === 'en-ligne';
  const body = { items: state.panier, source: state.panierSource || 'sur-place' };
  showLoader();
  const res = await api('/api/commandes', { method: 'POST', body: JSON.stringify(body) });
  hideLoader();
  if (res?.id) {
    const allBoissons = state.panier.every(i => i.categorie === 'Boissons');
    const hasBoissons = state.panier.some(i => i.categorie === 'Boissons');
    const dest = allBoissons ? 'au bar' : hasBoissons ? 'en cuisine et au bar' : 'en cuisine';
    toast(`Commande ${res.numero} envoyée ${dest} !`, 'success');
    closeModal('commande');
    if (isOnline) loadCommandesLigne(); else loadCommandes();
  } else if (res?.queued) {
    // Pas de réseau : la commande est en file locale, elle partira dès le retour de connexion.
    closeModal('commande');
  } else {
    toast(res?.error || 'Erreur lors de la création', 'error');
  }
}

// ─── COMMANDES EN LIGNE (caissière) ────────────────────

async function loadCommandesLigne() {
  const commandes = await api('/api/commandes');
  if (!commandes) return;
  state.commandes = commandes; // openEditCommande() lit depuis state.commandes

  const enLigne = commandes.filter(c => c.source === 'en-ligne' && !['annulee', 'servie'].includes(c.statut));
  const tbody = document.getElementById('commandes-ligne-tbody');
  if (enLigne.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state" style="padding:32px"><i class="fas fa-globe"></i><p>Aucune commande en ligne en cours</p></td></tr>';
    return;
  }

  tbody.innerHTML = enLigne.map(c => {
    const items = (c.items || []).map(i => `${i.quantite}x ${escapeHtml(i.nom)}`).join(', ');
    const hasBoissons = (c.items || []).some(i => i.categorie === 'Boissons');
    const hasPlats    = (c.items || []).some(i => i.categorie !== 'Boissons' && i.categorie !== 'Buffet');
    const cuisineInfo = hasPlats
      ? (['prete', 'servie'].includes(c.statut) ? '<br><small style="color:var(--success);font-size:.72rem"><i class="fas fa-check"></i> Cuisine prête</small>' : '<br><small style="color:var(--gray);font-size:.72rem"><i class="fas fa-fire"></i> En préparation</small>')
      : '';
    const barInfo = hasBoissons
      ? (c.boissonsStatut === 'prete' ? '<br><small style="color:var(--success);font-size:.72rem"><i class="fas fa-check"></i> Boissons prêtes</small>' : '<br><small style="color:#1565C0;font-size:.72rem"><i class="fas fa-wine-glass-alt"></i> Boissons en attente</small>')
      : '';
    return `
    <tr>
      <td data-label="N°"><strong>${c.numero}</strong></td>
      <td data-label="Date" style="font-size:.78rem;color:var(--gray)">${fmtDate(c.createdAt)}</td>
      <td data-label="Articles" style="font-size:.82rem">${items}</td>
      <td data-label="Total"><strong>${fmt(c.total)} FCFA</strong></td>
      <td data-label="Statut">${badgeStatus(c.statut)}${cuisineInfo}${barInfo}</td>
      <td data-label="Actions">
        <button class="btn btn-secondary btn-sm" onclick="openEditCommande('${c.id}')" title="Modifier">
          <i class="fas fa-edit"></i>
        </button>
        <button class="btn btn-success btn-sm" onclick="lancerLivraison('${c.id}','${c.numero}')">
          <i class="fas fa-truck"></i> Lancer la livraison
        </button>
      </td>
    </tr>`;
  }).join('');
}

window.lancerLivraison = async (id, numero) => {
  if (!confirm(`Lancer la livraison de ${numero} et générer la facture ?`)) return;
  showLoader();
  const res = await api(`/api/commandes/${id}/livraison`, { method: 'PUT' });
  hideLoader();
  if (!res?.id) { toast(res?.error || 'Erreur', 'error'); return; }
  toast(`Livraison lancée${res.factureUnifiee ? ` — facture ${res.factureUnifiee.numero} générée` : ''}`, 'success');
  loadCommandesLigne();
  if (res.factureUnifiee?.id) aperçuFacture(res.factureUnifiee.id);
};

// ─── CUISINE ───────────────────────────────────────────

async function loadCuisine(entering = false) {
  const today = new Date().toISOString().split('T')[0];
  const [data, factures, paiements] = await Promise.all([
    api('/api/commandes/cuisine'),
    api(`/api/factures?debut=${today}&fin=${today}&type=cuisine`),
    api(`/api/factures?debut=${today}&fin=${today}`),
  ]);

  const active   = data?.active   || [];
  const terminee = data?.terminee || [];
  const factureMap = {};
  const paiementMap = {};
  (paiements || []).forEach(f => { paiementMap[f.commandeId] = f; });

  // ── Annonce vocale des commandes nourriture ──
  const activeIds = new Set(active.map(c => c.id));
  if (entering) {
    active.forEach(c => speak(`Commande nourriture en cours : ${itemsSummary(c.items)}`));
  } else if (state.cuisineKnownIds) {
    active
      .filter(c => !state.cuisineKnownIds.has(c.id))
      .forEach(c => speak(`Nouvelle commande nourriture : ${itemsSummary(c.items)}`));
  }
  state.cuisineKnownIds = activeIds;
  (factures || []).forEach(f => { factureMap[f.commandeId] = f; });

  // ── Section commandes actives ──
  const grid  = document.getElementById('cuisine-grid');
  const count = document.getElementById('cuisine-count');

  if (active.length === 0) {
    grid.innerHTML = '<div class="empty-state"><i class="fas fa-check-circle" style="color:var(--success)"></i><p>Aucune commande en cours – tout est calme !</p></div>';
    if (count) count.textContent = '0 commande';
  } else {
    if (count) count.textContent = `${active.length} commande(s) en cours`;
    grid.innerHTML = active.map(c => {
      const minutesAgo = Math.floor((Date.now() - new Date(c.createdAt).getTime()) / 60000);
      const items = (c.items || []).map(i => `
        <div class="commande-item">
          <span><span class="commande-item-qty">${i.quantite}</span> ${i.nom}</span>
          <span style="color:var(--gray);font-size:.78rem">${fmt(i.prix)} FCFA</span>
        </div>`).join('');
      const totalPlats = (c.items || []).reduce((s, i) => s + i.sousTotal, 0);
      const isOnline = c.source === 'en-ligne';
      const actionBtn = isOnline
        ? ''
        : c.statut === 'en-attente'
        ? `<button class="btn btn-warning btn-sm" onclick="updateStatutCommande('${c.id}','prete')">
             <i class="fas fa-fire"></i> Démarrer
           </button>`
        : `<button class="btn btn-success btn-sm" onclick="updateStatutCommande('${c.id}','prete')">
             <i class="fas fa-check"></i> Prête !
           </button>`;
      return `
      <div class="commande-card ${c.statut}" id="card-${c.id}">
        <div class="commande-card-header">
          <div>
            <div class="commande-numero">${c.numero}</div>
            ${c.tableNumero ? `<div class="commande-table"><i class="fas fa-chair"></i> ${escapeHtml(c.tableNumero)}</div>` : ''}
            ${isOnline ? `<div class="commande-table" style="color:#0d47a1"><i class="fas fa-globe"></i> Commande en ligne</div>` : ''}
          </div>
          <div style="text-align:right">
            ${badgeStatus(c.statut)}
            <div class="commande-time">${minutesAgo < 1 ? 'À l\'instant' : `il y a ${minutesAgo} min`}</div>
          </div>
        </div>
        <div class="commande-items">${items}</div>
        ${c.note ? `<div class="commande-note"><i class="fas fa-sticky-note"></i> ${escapeHtml(c.note)}</div>` : ''}
        <div class="commande-total">${fmt(totalPlats)} FCFA</div>
        ${isOnline ? '<p style="font-size:.72rem;color:var(--gray);text-align:center;margin-top:6px"><i class="fas fa-info-circle"></i> Facturée par la caissière — pas de validation ici</p>' : `<div class="commande-actions">${actionBtn}</div>`}
      </div>`;
    }).join('');
  }

  // ── Section factures du jour ──
  const bilanSection = document.getElementById('cuisine-bilan-section');
  const bilanGrid    = document.getElementById('cuisine-bilan-grid');
  const bilanCount   = document.getElementById('cuisine-bilan-count');

  if (terminee.length === 0) {
    bilanSection.style.display = 'none';
  } else {
    bilanSection.style.display = 'block';
    bilanCount.textContent = `${terminee.length} facture(s)`;

    bilanGrid.innerHTML = terminee.map(c => {
      const f = factureMap[c.id];
      const paiement = paiementMap[c.id];
      const items = (c.items || []).map(i => `
        <div class="commande-item" style="font-size:.8rem">
          <span><span class="commande-item-qty">${i.quantite}</span> ${i.nom}</span>
          <span style="color:var(--gray)">${fmt(i.sousTotal)} FCFA</span>
        </div>`).join('');
      const factureInfo = f
        ? `<div style="margin-top:10px;padding:8px;background:#f0fdf4;border-radius:6px;border:1px solid #bbf7d0">
             <div style="font-size:.78rem;color:var(--gray);margin-bottom:4px">
               <i class="fas fa-receipt"></i> <strong>${f.numero}</strong>
             </div>
             <div style="display:flex;justify-content:flex-end;font-size:.82rem">
               <strong style="color:var(--success)">${fmt(f.total)} FCFA</strong>
             </div>
             <div style="font-size:.75rem;color:var(--gray);margin-top:2px">
               ${paiement?.statut === 'payee' ? '<span style="color:var(--success)">✓ Payée</span>' : '<span style="color:var(--warning)">⏳ En attente paiement</span>'}
             </div>
           </div>`
        : `<div style="margin-top:10px;padding:8px;background:#fef9c3;border-radius:6px;font-size:.78rem;color:var(--gray)">
             <i class="fas fa-spinner fa-spin"></i> Facture en cours de génération…
           </div>`;
      const printBtn = f
        ? `<button class="btn btn-secondary btn-sm" onclick="aperçuFactureCuisine('${f.id}')">
             <i class="fas fa-print"></i> Bon cuisine
           </button>`
        : '';
      return `
      <div class="commande-card prete" style="opacity:.85;border-left:4px solid var(--success)">
        <div class="commande-card-header">
          <div>
            <div class="commande-numero">${c.numero}</div>
            ${c.tableNumero ? `<div class="commande-table"><i class="fas fa-chair"></i> ${escapeHtml(c.tableNumero)}</div>` : ''}
          </div>
          <div style="text-align:right">
            ${badgeStatus(c.statut)}
            <div class="commande-time" style="font-size:.7rem">${fmtDate(c.updatedAt)}</div>
          </div>
        </div>
        <div class="commande-items">${items}</div>
        ${c.note ? `<div class="commande-note"><i class="fas fa-sticky-note"></i> ${escapeHtml(c.note)}</div>` : ''}
        ${factureInfo}
        ${printBtn ? `<div class="commande-actions" style="margin-top:8px">${printBtn}</div>` : ''}
      </div>`;
    }).join('');
  }
}

window.updateStatutCommande = async (id, statut) => {
  const res = await api(`/api/commandes/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ statut }),
  });
  if (res?.id) {
    const msgs = {
      'en-preparation': 'Préparation démarrée !',
      'prete': 'Commande prête – facture générée automatiquement !',
    };
    toast(msgs[statut] || 'Statut mis à jour', 'success');
    loadCuisine();
  }
};

// Impression du bilan complet du jour depuis la cuisine
window.printBilanJour = function printBilanJour() {
  const today = new Date().toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  const cards = document.getElementById('cuisine-bilan-grid').innerHTML;
  const w = window.open('', '_blank');
  w.document.write(`<!DOCTYPE html><html><head><title>Bilan du Jour – Cook Africa</title>
    <style>
      body { font-family: Arial, sans-serif; max-width: 860px; margin: 20px auto; font-size: 13px; }
      h1  { color: #8B1A1A; font-size: 1.1rem; border-bottom: 2px solid #8B1A1A; padding-bottom: 8px; }
      .cuisine-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px,1fr)); gap: 14px; }
      .commande-card { border: 1px solid #ddd; border-radius: 8px; padding: 12px; page-break-inside: avoid; }
      .commande-numero { font-weight: 800; font-size: .95rem; }
      .commande-item  { display: flex; justify-content: space-between; padding: 3px 0; font-size: .8rem; }
      .commande-item-qty { background: #8B1A1A; color: white; border-radius: 4px; padding: 1px 6px; font-size: .75rem; }
      .badge-status   { padding: 2px 8px; border-radius: 12px; font-size: .72rem; }
      @media print { button { display: none; } }
    </style>
  </head><body>
    <h1><i>COOK AFRICA</i> – Bilan du ${today}</h1>
    <div class="cuisine-grid">${cards}</div>
  </body></html>`);
  w.document.close();
  w.print();
}

// ─── FACTURATION ───────────────────────────────────────

// Annonce vocale des factures prêtes pour le client (payées ou non, hors bons internes)
async function checkFacturationReady(entering = false) {
  const today = new Date().toISOString().split('T')[0];
  const factures = await api(`/api/factures?debut=${today}&fin=${today}&statut=partielle`);
  if (!factures) return;

  const ids = new Set(factures.map(f => f.id));
  if (entering) {
    factures.forEach(f => speak(`Facture de la commande ${f.commandeNumero || f.numero} est prête pour le client`));
  } else if (state.factureKnownIds) {
    factures
      .filter(f => !state.factureKnownIds.has(f.id))
      .forEach(f => speak(`Facture de la commande ${f.commandeNumero || f.numero} est prête pour le client`));
  }
  state.factureKnownIds = ids;
}

async function loadFactures() {
  const debut  = document.getElementById('filter-fact-start')?.value || '';
  const fin    = document.getElementById('filter-fact-end')?.value   || '';
  const statut = document.getElementById('filter-fact-statut')?.value || '';
  const type   = document.getElementById('filter-fact-type')?.value  || '';

  let url = '/api/factures?';
  if (debut)  url += `debut=${debut}&`;
  if (fin)    url += `fin=${fin}&`;
  if (statut) url += `statut=${statut}&`;
  if (type)   url += `type=${type}`;

  const factures = await api(url);
  if (!factures) return;
  state.factures = factures;

  const isBonus = type === 'cuisine' || type === 'bar';
  const tbody = document.getElementById('factures-tbody');

  if (factures.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--gray)">Aucune facture</td></tr>`;
    return;
  }

  // Afficher le bouton de réparation s'il existe des numéros invalides
  const repairBtn = document.getElementById('btn-repair-numeros');
  if (repairBtn && state.user?.role === 'admin') {
    const hasBroken = factures.some(f => (!f.type || f.type === 'facture') && f.numero && f.numero.includes('NaN'));
    repairBtn.style.display = hasBroken ? 'inline-flex' : 'none';
  }

  tbody.innerHTML = factures.map(f => {
    const nbArticles = (f.items || []).length;
    const fType      = f.type || 'facture';
    const isPayFact  = !f.type || f.type === 'facture';
    const canPay     = isPayFact && f.statut === 'partielle';

    const typeBadge = fType === 'cuisine'
      ? `<span style="background:#FFF3E0;color:#E65100;border:1px solid #FFCC02;border-radius:12px;padding:2px 8px;font-size:.72rem;font-weight:600"><i class="fas fa-fire"></i> Cuisine</span>`
      : fType === 'bar'
      ? `<span style="background:#E3F2FD;color:#1565C0;border:1px solid #90CAF9;border-radius:12px;padding:2px 8px;font-size:.72rem;font-weight:600"><i class="fas fa-wine-glass-alt"></i> Bar</span>`
      : '';

    const printAction = fType === 'cuisine'
      ? `<button class="btn btn-secondary btn-sm" title="Bon cuisine" onclick="aperçuFactureCuisine('${f.id}')"><i class="fas fa-print"></i></button>`
      : fType === 'bar'
      ? `<button class="btn btn-secondary btn-sm" title="Bon bar" onclick="aperçuBonBar('${f.id}')"><i class="fas fa-print"></i></button>`
      : `<button class="btn btn-secondary btn-sm" onclick="aperçuFacture('${f.id}')"><i class="fas fa-print"></i></button>`;

    return `
    <tr>
      <td data-label="N°"><strong>${f.numero}</strong>${typeBadge ? ' ' + typeBadge : ''}</td>
      <td data-label="Date" style="font-size:.8rem">${fmtDateOnly(f.date)}</td>
      <td data-label="Commande" style="font-size:.82rem;color:var(--gray)">${f.commandeNumero || '—'}</td>
      <td data-label="Articles" style="font-size:.82rem">${nbArticles} article(s)</td>
      <td data-label="Total"><strong>${fmt(f.total)} FCFA</strong></td>
      <td data-label="Reste" style="color:${isPayFact && f.reste > 0 ? 'var(--danger)' : 'var(--success)'};font-weight:700">${isPayFact ? fmt(f.reste) + ' FCFA' : '—'}</td>
      <td data-label="Paiement" style="font-size:.82rem;color:var(--gray)">${f.modePaiement || '—'}</td>
      <td data-label="Statut">${isPayFact ? badgeStatus(f.statut) : '<span style="color:var(--gray);font-size:.8rem">Bon interne</span>'}</td>
      <td data-label="Actions">
        ${printAction}
        ${canPay ? `<button class="btn btn-success btn-sm" onclick="openPayFacture('${f.id}','${fmt(f.reste)}')"><i class="fas fa-check"></i> Payer</button>` : ''}
        ${canPay ? `<button class="btn btn-secondary btn-sm" onclick="openEditFacture('${f.id}')" title="Modifier (nécessite un code admin)"><i class="fas fa-edit"></i></button>` : ''}
        ${(canPay && state.user?.role === 'admin') ? `<button class="btn btn-accent btn-sm" onclick="openEditGrant('${f.id}')" title="Générer un code de modification"><i class="fas fa-key"></i></button>` : ''}
      </td>
    </tr>`;
  }).join('');
}

async function repairNumeros() {
  if (!confirm('Réparer les numéros de facture invalides (FACT-0NaN) en base ? Cette action est irréversible.')) return;
  showLoader();
  const res = await api('/api/factures/repair-numeros', { method: 'POST', body: '{}' });
  hideLoader();
  if (!res) { toast('Erreur lors de la réparation', 'error'); return; }
  toast(res.message || 'Réparation terminée', 'success');
  document.getElementById('btn-repair-numeros').style.display = 'none';
  loadFactures();
}

// ─── Autorisation temporaire de modification de facture ───

window.openEditGrant = (factureId) => {
  const f = state.factures.find(x => x.id === factureId);
  if (!f) return;
  document.getElementById('edit-grant-facture-id').value = factureId;
  document.getElementById('edit-grant-info').textContent = `Facture ${f.numero} — ${fmt(f.total)} FCFA`;
  document.getElementById('edit-grant-minutes').value = 15;
  document.getElementById('edit-grant-code-display').style.display = 'none';
  openModal('edit-grant');
};

async function generateEditCode() {
  const factureId = document.getElementById('edit-grant-facture-id').value;
  const minutes = Number(document.getElementById('edit-grant-minutes').value);
  showLoader();
  const res = await api(`/api/factures/${factureId}/edit-grant`, {
    method: 'POST',
    body: JSON.stringify({ minutes }),
  });
  hideLoader();
  if (!res?.code) { toast(res?.error || 'Erreur lors de la génération du code', 'error'); return; }

  document.getElementById('edit-grant-code').textContent = res.code;
  document.getElementById('edit-grant-expiry').textContent =
    new Date(res.expiresAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  document.getElementById('edit-grant-code-display').style.display = 'block';
  toast(`Code généré pour ${res.numero}`, 'success');
}

// ─── Modification d'une facture (côté caissière) ───────

window.openEditFacture = (factureId) => {
  const f = state.factures.find(x => x.id === factureId);
  if (!f) return;
  document.getElementById('editfact-facture-id').value = factureId;
  document.getElementById('editfact-numero').textContent = f.numero;
  document.getElementById('editfact-code').value = '';
  document.getElementById('editfact-code-step').style.display = 'block';
  document.getElementById('editfact-items-step').style.display = 'none';
  document.getElementById('btn-editfact-save').style.display = 'none';
  state.editFactureItems = [];
  state.editFactureCode = '';
  openModal('edit-facture');
};

async function unlockEditFacture() {
  const factureId = document.getElementById('editfact-facture-id').value;
  const code = document.getElementById('editfact-code').value.trim();
  if (!code) { toast('Entrez le code', 'warning'); return; }

  showLoader();
  const res = await api(`/api/factures/${factureId}/edit-grant/verify`, {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
  hideLoader();
  if (!res?.ok) { toast(res?.error || 'Code invalide', 'error'); return; }

  const f = state.factures.find(x => x.id === factureId);
  state.editFactureCode = code;
  state.editFactureItems = (f?.items || []).map(i => ({ ...i }));

  if (state.menu.length === 0) {
    const menu = await api('/api/menu');
    if (menu) state.menu = menu;
  }
  const select = document.getElementById('editfact-add-select');
  select.innerHTML = '<option value="">+ Ajouter un article…</option>' +
    state.menu.filter(m => m.disponible).map(m =>
      `<option value="${m.id}" data-nom="${m.nom}" data-prix="${m.prix}" data-cat="${m.categorie || ''}">${m.nom} — ${fmt(m.prix)} FCFA</option>`
    ).join('');

  document.getElementById('editfact-code-step').style.display = 'none';
  document.getElementById('editfact-items-step').style.display = 'block';
  document.getElementById('btn-editfact-save').style.display = 'inline-flex';
  renderEditFactureItems();
}

function renderEditFactureItems() {
  const container = document.getElementById('editfact-items');
  if (state.editFactureItems.length === 0) {
    container.innerHTML = '<p style="color:var(--gray);font-size:.85rem;text-align:center;padding:12px">Aucun article</p>';
  } else {
    container.innerHTML = state.editFactureItems.map((item, i) => `
      <div class="panier-item">
        <input class="panier-qty" type="number" min="1" max="99" value="${item.quantite}"
          onchange="updateEditFactureQty(${i}, this.value)">
        <span class="panier-item-nom">${escapeHtml(item.nom)}</span>
        <span class="panier-item-prix">${fmt(item.sousTotal)} FCFA</span>
        <button class="panier-item-remove" onclick="removeEditFactureItem(${i})">
          <i class="fas fa-trash"></i>
        </button>
      </div>`).join('');
  }
  const total = state.editFactureItems.reduce((s, i) => s + i.sousTotal, 0);
  document.getElementById('editfact-total').textContent = `Total : ${fmt(total)} FCFA`;
}

window.updateEditFactureQty = (i, qty) => {
  const q = Math.max(1, parseInt(qty, 10) || 1);
  state.editFactureItems[i].quantite = q;
  state.editFactureItems[i].sousTotal = state.editFactureItems[i].prix * q;
  renderEditFactureItems();
};

window.removeEditFactureItem = (i) => {
  state.editFactureItems.splice(i, 1);
  renderEditFactureItems();
};

function addToEditFacture(id, nom, prix, categorie) {
  const existing = state.editFactureItems.find(p => p.menuItemId === id);
  if (existing) { existing.quantite++; existing.sousTotal = existing.prix * existing.quantite; }
  else { state.editFactureItems.push({ menuItemId: id, nom, prix, categorie: categorie || '', quantite: 1, sousTotal: prix }); }
  renderEditFactureItems();
}

async function saveEditFacture() {
  if (state.editFactureItems.length === 0) { toast('La facture doit contenir au moins un article', 'warning'); return; }
  const factureId = document.getElementById('editfact-facture-id').value;

  showLoader();
  const res = await api(`/api/factures/${factureId}/edit-items`, {
    method: 'POST',
    body: JSON.stringify({ code: state.editFactureCode, items: state.editFactureItems }),
  });
  hideLoader();

  if (!res?.id) { toast(res?.error || 'Erreur lors de la modification', 'error'); return; }
  toast('Facture modifiée', 'success');
  closeModal('edit-facture');
  loadFactures();
}

function openNewFacture() {
  // Commande éligible : toutes les parties validées + pas encore facturée
  const cmdsEligibles = state.commandes.filter(c => {
    if (state.factures.some(f => f.commandeId === c.id)) return false;
    const hasBoissons = (c.items || []).some(i => i.categorie === 'Boissons');
    const hasPlats    = (c.items || []).some(i => i.categorie !== 'Boissons' && i.categorie !== 'Buffet');
    const kitchenOk   = !hasPlats || ['prete', 'servie'].includes(c.statut);
    const barOk       = !hasBoissons || c.boissonsStatut === 'prete';
    return kitchenOk && barOk;
  });
  const sel = document.getElementById('new-facture-commande');
  sel.innerHTML = '<option value="">Sélectionner une commande…</option>' +
    cmdsEligibles.map(c => `<option value="${c.id}">${c.numero} – ${fmt(c.total)} FCFA${c.tableNumero ? ' – ' + escapeHtml(c.tableNumero) : ''}</option>`).join('');
  openModal('new-facture');
}

window.openNewFactureForCmd = (cmdId) => {
  const c = state.commandes.find(x => x.id === cmdId);
  if (!c) return;
  const sel = document.getElementById('new-facture-commande');
  sel.innerHTML = `<option value="${c.id}" selected>${c.numero} – ${fmt(c.total)} FCFA</option>`;
  openModal('new-facture');
};

async function saveNewFacture() {
  const commandeId   = document.getElementById('new-facture-commande').value;
  const modePaiement = document.getElementById('new-facture-mode').value;

  if (!commandeId) { toast('Sélectionnez une commande', 'warning'); return; }

  showLoader();
  const res = await api('/api/factures', {
    method: 'POST',
    body: JSON.stringify({ commandeId, modePaiement }),
  });
  hideLoader();

  if (res?.id) {
    toast(`Facture ${res.numero} générée !`, 'success');
    closeModal('new-facture');
    loadFactures();
    // Afficher aperçu immédiatement
    await aperçuFacture(res.id);
  } else {
    toast(res?.error || 'Erreur lors de la génération', 'error');
  }
}

window.openPayFacture = (id, reste) => {
  document.getElementById('pay-facture-id').value   = id;
  document.getElementById('pay-facture-info').textContent = `Facture – Reste à payer : ${reste} FCFA`;
  document.getElementById('pay-facture-prices').style.display = 'none';
  document.getElementById('pay-facture-code-group').style.display = 'none';
  document.getElementById('pay-facture-discount-code').value = '';
  state.payFactureItems = null; // tant que non ouvert, on paie au prix de la facture telle quelle
  openModal('pay-facture');
};

// Prix standard d'un article : celui du menu (par menuItemId), sinon son prix actuel sur la facture
function standardPriceFor(item) {
  const menuItem = state.menu.find(m => m.id === item.menuItemId);
  return menuItem ? menuItem.prix : item.prix;
}

async function togglePayFacturePrices() {
  const panel = document.getElementById('pay-facture-prices');
  if (panel.style.display === 'block') { panel.style.display = 'none'; return; }

  if (state.menu.length === 0) {
    const menu = await api('/api/menu');
    if (menu) state.menu = menu;
  }
  const id = document.getElementById('pay-facture-id').value;
  const f = state.factures.find(x => x.id === id);
  if (!f) return;

  state.payFactureItems = (f.items || []).map(i => ({ ...i }));
  renderPayFacturePrices();
  panel.style.display = 'block';
}

function renderPayFacturePrices() {
  const container = document.getElementById('pay-facture-items');
  container.innerHTML = state.payFactureItems.map((item, i) => `
    <div class="panier-item">
      <span class="panier-item-nom">${escapeHtml(item.nom)} <small style="color:var(--gray)">(x${item.quantite})</small></span>
      <input type="number" min="0" step="1" value="${item.prix}" style="width:90px" data-i="${i}" class="pay-price-input">
      <span class="panier-item-prix">${fmt(item.sousTotal)} FCFA</span>
    </div>`).join('');

  container.querySelectorAll('.pay-price-input').forEach(inp => {
    inp.addEventListener('input', function () {
      const i = Number(this.dataset.i);
      const prix = Math.max(0, Number(this.value) || 0);
      state.payFactureItems[i].prix = prix;
      state.payFactureItems[i].sousTotal = prix * state.payFactureItems[i].quantite;
      renderPayFacturePrices();
    });
  });

  const total = state.payFactureItems.reduce((s, i) => s + i.sousTotal, 0);
  document.getElementById('pay-facture-total-live').textContent = `Nouveau total : ${fmt(total)} FCFA`;

  const belowStandard = state.payFactureItems.some(i => i.prix < standardPriceFor(i));
  document.getElementById('pay-facture-code-group').style.display = belowStandard ? 'block' : 'none';
}

async function confirmPayFacture() {
  const id   = document.getElementById('pay-facture-id').value;
  const mode = document.getElementById('pay-facture-mode').value;
  const body = { modePaiement: mode };

  if (state.payFactureItems) {
    body.items = state.payFactureItems;
    const code = document.getElementById('pay-facture-discount-code').value.trim();
    if (code) body.discountCode = code;
  }

  showLoader();
  const res = await api(`/api/factures/${id}/pay`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  hideLoader();
  if (res?.statut === 'payee') {
    toast('Paiement enregistré !', 'success');
    closeModal('pay-facture');
    loadFactures();
  } else {
    toast(res?.error || 'Erreur', 'error');
  }
}

window.aperçuFacture = async (id) => {
  let f = state.factures.find(x => x.id === id);
  if (!f) {
    const res = await api(`/api/factures/${id}`);
    if (!res) return;
    f = res;
  }

  const logoUrl = window.location.origin + '/logo-cookafrica.png';

  // Grouper les articles par catégorie pour un affichage clair
  const buffetItems   = (f.items || []).filter(i => i.categorie === 'Buffet');
  const platsItems    = (f.items || []).filter(i => i.categorie !== 'Boissons' && i.categorie !== 'Buffet');
  const boissonsItems = (f.items || []).filter(i => i.categorie === 'Boissons');

  const renderRows = items => items.map(i => `
    <tr>
      <td>${i.nom}</td>
      <td style="text-align:center">${i.quantite}</td>
      <td style="text-align:right">${fmt(i.prix)}</td>
      <td style="text-align:right"><strong>${fmt(i.sousTotal)}</strong></td>
    </tr>`).join('');

  const sectionBoissons = boissonsItems.length > 0 ? `
    <tr style="background:#eff6ff">
      <td colspan="4" style="font-weight:700;font-size:.8rem;color:#1565C0;padding:6px 8px">
        <i class="fas fa-wine-glass-alt"></i> Boissons
      </td>
    </tr>
    ${renderRows(boissonsItems)}` : '';

  const sectionPlats = platsItems.length > 0 ? `
    <tr style="background:#fdf4f0">
      <td colspan="4" style="font-weight:700;font-size:.8rem;color:var(--primary);padding:6px 8px">
        <i class="fas fa-utensils"></i> Plats
      </td>
    </tr>
    ${renderRows(platsItems)}` : '';

  const sectionBuffet = buffetItems.length > 0 ? `
    <tr style="background:#fefce8">
      <td colspan="4" style="font-weight:700;font-size:.8rem;color:#a16207;padding:6px 8px">
        <i class="fas fa-utensils"></i> Buffet
      </td>
    </tr>
    ${renderRows(buffetItems)}` : '';

  const validateurs = [];
  if (f.validatedByCuisinier) {
    const nomCuisinier = f.validatedByCuisinierNom || f.validatedByCuisinier;
    validateurs.push(`<span><i class="fas fa-fire" style="color:var(--primary)"></i> Cuisine : <strong>${nomCuisinier}</strong></span>`);
  }
  if (f.validatedByBarman) {
    const nomBarman = f.validatedByBarmanNom || f.validatedByBarman;
    validateurs.push(`<span><i class="fas fa-wine-glass-alt" style="color:#1565C0"></i> Bar : <strong>${nomBarman}</strong></span>`);
  }

  document.getElementById('facture-print-area').innerHTML = `
    <div class="facture-print">
      <div class="facture-print-header">
        <img src="${logoUrl}" alt="Cook Africa" style="height:72px;margin-bottom:6px;display:block;margin-left:auto;margin-right:auto"
             onerror="this.style.display='none'">
        <p style="margin-top:4px;font-size:.9rem"><strong>FACTURE N° ${f.numero}</strong></p>
        <p style="font-size:.78rem;color:var(--gray)">Date : ${fmtDateOnly(f.date)}</p>
        ${f.tableNumero ? `<p style="font-size:.78rem"><strong>Table :</strong> ${escapeHtml(f.tableNumero)}</p>` : ''}
        ${f.commandeNumero ? `<p style="font-size:.78rem;color:var(--gray)">Commande : ${f.commandeNumero}</p>` : ''}
        ${f.serveurNom ? `<p style="font-size:.78rem">Servi par : <strong>${escapeHtml(f.serveurNom)}</strong></p>` : ''}
        ${f.caissiereName ? `<p style="font-size:.78rem"><i class="fas fa-user-tie"></i> Caissière : <strong>${f.caissiereName}</strong></p>` : ''}
      </div>
      <table class="facture-items">
        <thead><tr><th>Article</th><th>Qté</th><th>Prix unit.</th><th>Sous-total</th></tr></thead>
        <tbody>${sectionPlats}${sectionBuffet}${sectionBoissons}</tbody>
      </table>
      <table class="facture-totaux">
        <tr class="facture-total-final">
          <td><strong>TOTAL</strong></td>
          <td><strong>${fmt(f.total)} FCFA</strong></td>
        </tr>
        ${f.reste > 0
          ? `<tr><td style="color:var(--danger)"><strong>RESTE À PAYER</strong></td><td style="color:var(--danger)"><strong>${fmt(f.reste)} FCFA</strong></td></tr>`
          : `<tr><td style="color:var(--success)"><strong>PAYÉE ✓</strong></td><td></td></tr>`}
      </table>
      <div style="margin-top:14px;padding-top:10px;border-top:1px dashed var(--border);font-size:.78rem;color:var(--gray)">
        ${validateurs.length ? `<div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:6px">${validateurs.join('')}</div>` : ''}
        <p>Mode de paiement : <strong>${f.modePaiement || '—'}</strong></p>
        <p style="margin-top:6px;text-align:center">Merci de votre visite !</p>
        <p style="font-size:.7rem;text-align:center;margin-top:4px">Cook Africa – Le restaurant qui rassemble</p>
      </div>
    </div>`;

  openModal('apercu-facture');
};

function printFacture() {
  const content = document.getElementById('facture-print-area').innerHTML;
  const logoUrl = window.location.origin + '/logo-cookafrica.png';
  const w = window.open('', '_blank');
  w.document.write(`<!DOCTYPE html><html><head><title>Facture Cook Africa</title>
    <style>
      body { font-family: Arial, sans-serif; max-width: 480px; margin: 20px auto; font-size: 13px; }
      p { margin: 3px 0; }
      .facture-print-header { text-align: center; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 2px dashed #ccc; }
      .facture-items { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
      .facture-items th { background: #8B1A1A; color: white; padding: 6px; text-align: left; }
      .facture-items td { padding: 6px; border-bottom: 1px solid #eee; }
      .facture-totaux { margin-left: auto; width: 220px; }
      .facture-totaux td { padding: 4px; }
      .facture-totaux td:last-child { text-align: right; font-weight: bold; }
      .facture-total-final td { font-size: 1.05rem; border-top: 2px solid #333; padding-top: 6px; }
      @media print { button { display: none; } }
    </style>
  </head><body>${content}</body></html>`);
  w.document.close();
  w.print();
}

// Aperçu + impression du bon cuisine (plats uniquement, sans boissons)
window.aperçuFactureCuisine = async (id) => {
  let f = state.factures.find(x => x.id === id);
  if (!f) {
    const res = await api(`/api/factures/${id}`);
    if (!res) return;
    f = res;
  }

  const logoUrl = window.location.origin + '/logo-cookafrica.png';
  const platsItems = (f.items || []).filter(i => i.categorie !== 'Boissons' && i.categorie !== 'Buffet');
  if (platsItems.length === 0) { toast('Aucun plat dans cette facture', 'warning'); return; }
  const totalPlats = platsItems.reduce((s, i) => s + i.sousTotal, 0);

  const rows = platsItems.map(i => `
    <tr>
      <td>${i.nom}</td>
      <td style="text-align:center">${i.quantite}</td>
      <td style="text-align:right">${fmt(i.prix)}</td>
      <td style="text-align:right"><strong>${fmt(i.sousTotal)}</strong></td>
    </tr>`).join('');

  document.getElementById('facture-print-area').innerHTML = `
    <div class="facture-print">
      <div class="facture-print-header">
        <img src="${logoUrl}" alt="Cook Africa" style="height:60px;margin-bottom:6px;display:block;margin-left:auto;margin-right:auto"
             onerror="this.style.display='none'">
        <p style="margin-top:4px;font-size:1rem;color:var(--primary)"><strong><i class="fas fa-fire"></i> BON CUISINE</strong></p>
        <p style="font-size:.78rem;color:var(--gray)">Réf. facture : ${f.numero}</p>
        <p style="font-size:.78rem;color:var(--gray)">Date : ${fmtDateOnly(f.date)}</p>
        ${f.tableNumero ? `<p style="font-size:.78rem"><strong>Table :</strong> ${escapeHtml(f.tableNumero)}</p>` : ''}
        ${f.commandeNumero ? `<p style="font-size:.78rem;color:var(--gray)">Commande : ${f.commandeNumero}</p>` : ''}
      </div>
      <table class="facture-items">
        <thead><tr><th>Plat</th><th>Qté</th><th>Prix unit.</th><th>Sous-total</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <table class="facture-totaux">
        <tr class="facture-total-final">
          <td><strong>TOTAL CUISINE</strong></td>
          <td><strong>${fmt(totalPlats)} FCFA</strong></td>
        </tr>
      </table>
      <div style="margin-top:14px;padding-top:10px;border-top:1px dashed var(--border);font-size:.78rem;color:var(--gray)">
        ${f.serveurNom ? `<p><i class="fas fa-user"></i> Servi par : <strong>${escapeHtml(f.serveurNom)}</strong></p>` : ''}
        ${f.caissiereName ? `<p><i class="fas fa-user-tie"></i> Caissière : <strong>${f.caissiereName}</strong></p>` : ''}
        ${f.validatedByCuisinier ? `<p><i class="fas fa-fire" style="color:var(--primary)"></i> Cuisinier : <strong>${f.validatedByCuisinierNom || f.validatedByCuisinier}</strong></p>` : ''}
        <p style="margin-top:6px;text-align:center;font-style:italic">Bon interne – Usage cuisine uniquement</p>
        <p style="font-size:.7rem;text-align:center;margin-top:4px">Cook Africa – Le restaurant qui rassemble</p>
      </div>
    </div>`;

  openModal('apercu-facture');
};

// Aperçu + impression du bon bar depuis un ID de facture BD (bons stockés en BD)
window.aperçuBonBar = async (id) => {
  let f = state.factures.find(x => x.id === id);
  if (!f) {
    const res = await api(`/api/factures/${id}`);
    if (!res) return;
    f = res;
  }

  const logoUrl = window.location.origin + '/logo-cookafrica.png';
  const boissonsItems = (f.items || []).filter(i => i.categorie === 'Boissons');
  if (boissonsItems.length === 0) { toast('Aucune boisson dans ce bon', 'warning'); return; }
  const totalBar = boissonsItems.reduce((s, i) => s + i.sousTotal, 0);

  const rows = boissonsItems.map(i => `
    <tr>
      <td>${i.nom}</td>
      <td style="text-align:center">${i.quantite}</td>
      <td style="text-align:right">${fmt(i.prix)}</td>
      <td style="text-align:right"><strong>${fmt(i.sousTotal)}</strong></td>
    </tr>`).join('');

  document.getElementById('facture-print-area').innerHTML = `
    <div class="facture-print">
      <div class="facture-print-header">
        <img src="${logoUrl}" alt="Cook Africa" style="height:60px;margin-bottom:6px;display:block;margin-left:auto;margin-right:auto"
             onerror="this.style.display='none'">
        <p style="margin-top:4px;font-size:1rem;color:#1565C0"><strong><i class="fas fa-wine-glass-alt"></i> BON BAR</strong></p>
        <p style="font-size:.78rem;color:var(--gray)">Réf. : ${f.numero}</p>
        <p style="font-size:.78rem;color:var(--gray)">Date : ${fmtDateOnly(f.date)}</p>
        ${f.tableNumero ? `<p style="font-size:.78rem"><strong>Table :</strong> ${escapeHtml(f.tableNumero)}</p>` : ''}
        ${f.commandeNumero ? `<p style="font-size:.78rem;color:var(--gray)">Commande : ${f.commandeNumero}</p>` : ''}
      </div>
      <table class="facture-items">
        <thead><tr><th>Boisson</th><th>Qté</th><th>Prix unit.</th><th>Sous-total</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <table class="facture-totaux">
        <tr class="facture-total-final">
          <td><strong>TOTAL BAR</strong></td>
          <td><strong>${fmt(totalBar)} FCFA</strong></td>
        </tr>
      </table>
      <div style="margin-top:14px;padding-top:10px;border-top:1px dashed var(--border);font-size:.78rem;color:var(--gray)">
        ${f.serveurNom ? `<p><i class="fas fa-user"></i> Servi par : <strong>${escapeHtml(f.serveurNom)}</strong></p>` : ''}
        ${f.validatedByBarman ? `<p><i class="fas fa-wine-glass-alt" style="color:#1565C0"></i> Barman : <strong>${f.validatedByBarmanNom || f.validatedByBarman}</strong></p>` : ''}
        <p style="margin-top:6px;text-align:center;font-style:italic">Bon interne – Usage bar uniquement</p>
        <p style="font-size:.7rem;text-align:center;margin-top:4px">Cook Africa – Le restaurant qui rassemble</p>
      </div>
    </div>`;

  openModal('apercu-facture');
};

// ─── ÉCRAN BAR ─────────────────────────────────────────

async function loadBarman(entering = false) {
  const data = await api('/api/commandes/bar');
  if (!data) return;

  const active       = data.active       || [];
  const done         = data.done         || [];
  const facturesMap  = data.facturesMap  || {};
  const paiementsMap = data.paiementsMap || {};
  state.barFactures = facturesMap; // factures indexées par commandeId

  // ── Annonce vocale des commandes boissons ──
  const activeIds = new Set(active.map(c => c.id));
  if (entering) {
    active.forEach(c => {
      const boissonsItems = (c.items || []).filter(i => i.categorie === 'Boissons');
      speak(`Commande boissons en cours : ${itemsSummary(boissonsItems)}`);
    });
  } else if (state.barKnownIds) {
    active
      .filter(c => !state.barKnownIds.has(c.id))
      .forEach(c => {
        const boissonsItems = (c.items || []).filter(i => i.categorie === 'Boissons');
        speak(`Nouvelle commande boissons : ${itemsSummary(boissonsItems)}`);
      });
  }
  state.barKnownIds = activeIds;

  // ── Commandes boissons actives ──
  const grid  = document.getElementById('barman-grid');
  const count = document.getElementById('barman-count');

  if (active.length === 0) {
    grid.innerHTML = '<div class="empty-state"><i class="fas fa-wine-glass-alt" style="color:var(--success)"></i><p>Aucune commande de boisson en attente !</p></div>';
    if (count) count.textContent = '0 boisson en attente';
  } else {
    if (count) count.textContent = `${active.length} commande(s) de boissons`;
    grid.innerHTML = active.map(c => {
      const minutesAgo = Math.floor((Date.now() - new Date(c.createdAt).getTime()) / 60000);
      const boissonsItems = (c.items || []).filter(i => i.categorie === 'Boissons');
      const items = boissonsItems.map(i => `
        <div class="commande-item">
          <span><span class="commande-item-qty">${i.quantite}</span> ${i.nom}</span>
          <span style="color:var(--gray);font-size:.78rem">${fmt(i.prix)} FCFA</span>
        </div>`).join('');
      const total = boissonsItems.reduce((s, i) => s + i.sousTotal, 0);
      const isOnline = c.source === 'en-ligne';
      return `
      <div class="commande-card en-attente bar-card" id="bar-card-${c.id}">
        <div class="commande-card-header">
          <div>
            <div class="commande-numero">${c.numero}</div>
            ${c.tableNumero ? `<div class="commande-table"><i class="fas fa-chair"></i> ${escapeHtml(c.tableNumero)}</div>` : ''}
            ${isOnline ? `<div class="commande-table" style="color:#0d47a1"><i class="fas fa-globe"></i> Commande en ligne</div>` : ''}
          </div>
          <div style="text-align:right">
            ${badgeStatus(c.statut)}
            <div class="commande-time">${minutesAgo < 1 ? "À l'instant" : `il y a ${minutesAgo} min`}</div>
          </div>
        </div>
        <div class="commande-items">${items}</div>
        ${c.note ? `<div class="commande-note"><i class="fas fa-sticky-note"></i> ${escapeHtml(c.note)}</div>` : ''}
        <div class="commande-total">${fmt(total)} FCFA</div>
        ${isOnline
          ? '<p style="font-size:.72rem;color:var(--gray);text-align:center;margin-top:6px"><i class="fas fa-info-circle"></i> Facturée par la caissière — pas de validation ici</p>'
          : `<div class="commande-actions">
               <button class="btn btn-success btn-sm" style="background:#1565C0;border-color:#1565C0" onclick="barmanPret('${c.id}')">
                 <i class="fas fa-wine-glass-alt"></i> Prêt !
               </button>
             </div>`}
      </div>`;
    }).join('');
  }

  // ── Stock boissons ──
  loadBarmanStock();

  // ── Boissons servies du jour ──
  const bilanSection = document.getElementById('barman-bilan-section');
  const bilanGrid    = document.getElementById('barman-bilan-grid');
  const bilanCount   = document.getElementById('barman-bilan-count');

  if (done.length === 0) {
    bilanSection.style.display = 'none';
  } else {
    bilanSection.style.display = 'block';
    bilanCount.textContent = `${done.length}`;
    bilanGrid.innerHTML = done.map(c => {
      const boissonsItems = (c.items || []).filter(i => i.categorie === 'Boissons');
      const total = boissonsItems.reduce((s, i) => s + i.sousTotal, 0);
      const items = boissonsItems.map(i => `
        <div class="commande-item" style="font-size:.8rem">
          <span><span class="commande-item-qty">${i.quantite}</span> ${i.nom}</span>
          <span style="color:var(--gray)">${fmt(i.sousTotal)} FCFA</span>
        </div>`).join('');
      const f = facturesMap[c.id];
      const paiement = paiementsMap[c.id];
      const factureInfo = f
        ? `<div style="margin-top:10px;padding:8px;background:#eff6ff;border-radius:6px;border:1px solid #bfdbfe">
             <div style="font-size:.78rem;color:var(--gray);margin-bottom:4px">
               <i class="fas fa-receipt"></i> <strong>${f.numero}</strong>
             </div>
             <div style="font-size:.75rem;color:var(--gray);margin-top:2px">
               ${paiement?.statut === 'payee' ? '<span style="color:var(--success)">✓ Payée</span>' : '<span style="color:var(--warning)">⏳ En attente paiement</span>'}
             </div>
           </div>`
        : `<div style="margin-top:10px;padding:8px;background:#fef9c3;border-radius:6px;font-size:.78rem;color:var(--gray)">
             <i class="fas fa-spinner fa-spin"></i> Facture en cours…
           </div>`;
      const printBtn = f
        ? `<div class="commande-actions" style="margin-top:8px">
             <button class="btn btn-sm" style="background:#1565C0;color:#fff;border-color:#1565C0" onclick="aperçuFactureBar('${c.id}')">
               <i class="fas fa-print"></i> Bon bar
             </button>
           </div>`
        : '';
      return `
      <div class="commande-card prete bar-card" style="opacity:.85;border-left:4px solid #1565C0">
        <div class="commande-card-header">
          <div>
            <div class="commande-numero">${c.numero}</div>
            ${c.tableNumero ? `<div class="commande-table"><i class="fas fa-chair"></i> ${escapeHtml(c.tableNumero)}</div>` : ''}
          </div>
          <div style="text-align:right">
            <span class="badge-status prete">✅ Boissons servies</span>
            <div class="commande-time" style="font-size:.7rem">${fmtDate(c.updatedAt)}</div>
          </div>
        </div>
        <div class="commande-items">${items}</div>
        ${c.note ? `<div class="commande-note"><i class="fas fa-sticky-note"></i> ${escapeHtml(c.note)}</div>` : ''}
        <div class="commande-total">${fmt(total)} FCFA</div>
        ${factureInfo}
        ${printBtn}
      </div>`;
    }).join('');
  }
}

async function loadBarmanStock() {
  const stocks = await api('/api/stocks');
  if (!stocks) return;
  const boissonsStocks = stocks.filter(s => s.categorie === 'Boissons');
  const tbody = document.getElementById('barman-stock-tbody');
  if (!tbody) return;

  if (boissonsStocks.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--gray)">Aucun stock de boissons enregistré</td></tr>';
    return;
  }

  tbody.innerHTML = boissonsStocks.map(s => {
    const isBas = s.quantite < s.minimum;
    return `
    <tr style="${isBas ? 'background:#fff5f5' : ''}">
      <td data-label="Boisson"><strong>${s.nom}</strong></td>
      <td data-label="Quantité"><strong style="color:${isBas ? 'var(--danger)' : 'var(--dark)'}">${s.quantite}</strong></td>
      <td data-label="Minimum" style="color:var(--gray)">${s.minimum}</td>
      <td data-label="Unité" style="color:var(--gray);font-size:.82rem">${s.unite}</td>
      <td data-label="État"><span class="badge-status ${isBas ? 'bas' : 'disponible'}">${isBas ? '⚠️ Stock bas' : '✅ OK'}</span></td>
    </tr>`;
  }).join('');
}

window.barmanPret = async (id) => {
  const res = await api(`/api/commandes/${id}/bar-pret`, { method: 'PUT', body: '{}' });
  if (res?.boissonsStatut === 'prete') {
    const msg = res.factureUnifiee
      ? `Boissons prêtes – Facture ${res.factureUnifiee.numero} générée !`
      : 'Boissons prêtes – en attente de la cuisine.';
    toast(msg, 'success');
    loadBarman();
  } else {
    toast(res?.error || 'Erreur', 'error');
  }
};

window.aperçuFactureBar = (commandeId) => {
  const f = state.barFactures?.[commandeId];
  if (!f) { toast('Bon bar introuvable', 'error'); return; }

  const logoUrl = window.location.origin + '/logo-cookafrica.png';
  const boissonsItems = (f.items || []).filter(i => i.categorie === 'Boissons');
  if (boissonsItems.length === 0) { toast('Aucune boisson dans cette facture', 'warning'); return; }
  const totalBoissons = boissonsItems.reduce((s, i) => s + i.sousTotal, 0);

  const items = boissonsItems.map(i => `
    <tr>
      <td>${i.nom}</td>
      <td style="text-align:center">${i.quantite}</td>
      <td style="text-align:right">${fmt(i.prix)}</td>
      <td style="text-align:right"><strong>${fmt(i.sousTotal)}</strong></td>
    </tr>`).join('');

  document.getElementById('facture-print-area').innerHTML = `
    <div class="facture-print">
      <div class="facture-print-header">
        <img src="${logoUrl}" alt="Cook Africa" style="height:60px;margin-bottom:6px;display:block;margin-left:auto;margin-right:auto"
             onerror="this.style.display='none'">
        <p style="margin-top:4px;font-size:1rem;color:#1565C0"><strong><i class="fas fa-wine-glass-alt"></i> BON BAR</strong></p>
        <p style="font-size:.78rem;color:var(--gray)">Réf. facture : ${f.numero}</p>
        <p style="font-size:.78rem;color:var(--gray)">Date : ${fmtDateOnly(f.date)}</p>
        ${f.tableNumero ? `<p style="font-size:.78rem"><strong>Table :</strong> ${escapeHtml(f.tableNumero)}</p>` : ''}
        ${f.commandeNumero ? `<p style="font-size:.78rem;color:var(--gray)">Commande : ${f.commandeNumero}</p>` : ''}
      </div>
      <table class="facture-items">
        <thead><tr><th>Boisson</th><th>Qté</th><th>Prix unit.</th><th>Sous-total</th></tr></thead>
        <tbody>${items}</tbody>
      </table>
      <table class="facture-totaux">
        <tr class="facture-total-final">
          <td><strong>TOTAL BAR</strong></td>
          <td><strong>${fmt(totalBoissons)} FCFA</strong></td>
        </tr>
      </table>
      <div style="margin-top:14px;padding-top:10px;border-top:1px dashed var(--border);font-size:.78rem;color:var(--gray)">
        ${f.serveurNom ? `<p><i class="fas fa-user"></i> Servi par : <strong>${escapeHtml(f.serveurNom)}</strong></p>` : ''}
        ${f.caissiereName ? `<p><i class="fas fa-user-tie"></i> Caissière : <strong>${f.caissiereName}</strong></p>` : ''}
        ${f.validatedByBarman ? `<p><i class="fas fa-wine-glass-alt" style="color:#1565C0"></i> Barman : <strong>${f.validatedByBarmanNom || f.validatedByBarman}</strong></p>` : ''}
        <p style="margin-top:6px;text-align:center;font-style:italic">Bon interne – Usage bar uniquement</p>
        <p style="font-size:.7rem;text-align:center;margin-top:4px">Cook Africa – Le restaurant qui rassemble</p>
      </div>
    </div>`;

  openModal('apercu-facture');
};

// ─── MENU ──────────────────────────────────────────────

async function loadMenu() {
  showLoader();
  const menu = await api('/api/menu');
  hideLoader();
  if (!menu) return;
  state.menu = menu;

  // Reconstruire le filtre catégorie à partir des catégories existantes
  const sel = document.getElementById('filter-menu-cat');
  const currentVal = sel.value;
  const cats = [...new Set(menu.map(m => m.categorie).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">Toutes les catégories</option>' +
    cats.map(c => `<option value="${c}"${c === currentVal ? ' selected' : ''}>${c}</option>`).join('');

  // Synchroniser aussi le select du formulaire plat avec les catégories connues
  const platCatSel = document.getElementById('plat-categorie');
  if (platCatSel) {
    const defaults = ['Plats', 'Entrées', 'Accompagnement', 'Sauce', 'Desserts', 'Buffet', 'Boissons'];
    const allCats  = [...new Set([...defaults, ...cats])].sort();
    const prev = platCatSel.value;
    platCatSel.innerHTML = allCats
      .map(c => `<option value="${c}"${c === prev ? ' selected' : ''}>${c === 'Buffet' ? 'Buffet (non envoyé en cuisine)' : c}</option>`).join('');
  }

  renderMenu(menu);
}

function renderMenu(menu) {
  const catFilter = document.getElementById('filter-menu-cat')?.value || '';
  const filtered  = catFilter ? menu.filter(m => m.categorie === catFilter) : menu;
  const grid = document.getElementById('menu-grid');

  if (filtered.length === 0) {
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><i class="fas fa-book-open"></i><p>Aucun plat dans le menu</p></div>';
    return;
  }

  grid.innerHTML = filtered.map(m => `
    <div class="menu-card ${m.disponible ? '' : 'indisponible'}">
      <div class="menu-card-cat">${m.categorie}</div>
      <div class="menu-card-nom">${m.nom}</div>
      <div class="menu-card-desc">${m.description || ''}</div>
      <div class="menu-card-footer">
        <div class="menu-card-prix">${fmt(m.prix)} FCFA</div>
        <div style="display:flex;gap:6px;align-items:center">
          <span class="badge-status ${m.disponible ? 'disponible' : 'annulee'}" style="font-size:.7rem">
            ${m.disponible ? 'Dispo' : 'Indispo'}
          </span>
          ${state.user?.role === 'admin' ? `
            <button class="btn btn-secondary btn-sm" onclick="editPlat('${m.id}')">
              <i class="fas fa-edit"></i>
            </button>` : ''}
        </div>
      </div>
    </div>`).join('');
}

window.editPlat = (id) => {
  const m = state.menu.find(x => x.id === id);
  if (!m) return;
  document.getElementById('modal-plat-title').textContent = 'Modifier le plat';
  document.getElementById('plat-id').value          = m.id;
  document.getElementById('plat-nom').value         = m.nom;
  document.getElementById('plat-categorie').value   = m.categorie;
  document.getElementById('plat-prix').value        = m.prix;
  document.getElementById('plat-disponible').value  = String(m.disponible);
  document.getElementById('plat-description').value = m.description || '';
  openModal('plat');
};

function openNewPlat() {
  document.getElementById('modal-plat-title').textContent = 'Nouveau plat';
  document.getElementById('form-plat').reset();
  document.getElementById('plat-id').value = '';
  openModal('plat');
}

async function savePlat() {
  const id = document.getElementById('plat-id').value;
  const body = {
    nom:         document.getElementById('plat-nom').value.trim(),
    categorie:   document.getElementById('plat-categorie').value,
    prix:        Number(document.getElementById('plat-prix').value),
    disponible:  document.getElementById('plat-disponible').value === 'true',
    description: document.getElementById('plat-description').value.trim(),
  };
  if (!body.nom || !body.prix) { toast('Nom et prix requis', 'warning'); return; }

  showLoader();
  const res = id
    ? await api(`/api/menu/${id}`, { method: 'PUT',  body: JSON.stringify(body) })
    : await api('/api/menu',        { method: 'POST', body: JSON.stringify(body) });
  hideLoader();

  if (res?.id || res?.nom) {
    toast(id ? 'Plat mis à jour' : 'Plat créé', 'success');
    closeModal('plat');
    loadMenu();
  } else {
    toast(res?.error || 'Erreur', 'error');
  }
}

async function seedMenu() {
  if (!confirm('Initialiser le menu avec les plats par défaut ?')) return;
  showLoader();
  const res = await api('/api/menu/seed', { method: 'POST', body: '{}' });
  hideLoader();
  if (res?.message) { toast(res.message, 'success'); loadMenu(); }
  else toast(res?.error || 'Erreur', 'error');
}

// ─── STOCKS ────────────────────────────────────────────

function initStockSubtabs() {
  document.querySelectorAll('.stock-subtab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.stock-subtab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.stock-subtab-content').forEach(c => c.classList.add('hidden'));
      btn.classList.add('active');
      document.getElementById(`stock-subtab-${btn.dataset.subtab}`).classList.remove('hidden');
    });
  });
}

async function loadStocksPlats() {
  const dateInput = document.getElementById('plats-date');
  if (!dateInput.value) dateInput.value = new Date().toISOString().split('T')[0];
  const date = dateInput.value;

  const tbody = document.getElementById('plats-jour-tbody');
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--gray)"><i class="fas fa-spinner fa-spin"></i> Chargement…</td></tr>';

  const [menu, platStocks] = await Promise.all([
    state.menu.length ? Promise.resolve(state.menu) : api('/api/menu'),
    api(`/api/stocks/plats?date=${date}`),
  ]);

  if (!menu) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--danger)"><i class="fas fa-exclamation-triangle"></i> Impossible de charger le menu.</td></tr>';
    toast('Erreur de chargement du menu', 'error');
    return;
  }
  if (state.menu.length === 0) state.menu = menu;

  const platsMap = {};
  (platStocks || []).forEach(p => { platsMap[p.menuItemId] = p; });

  const dishes = menu.filter(m => m.disponible !== false);

  if (dishes.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--gray)">Aucun plat au menu</td></tr>';
    return;
  }

  tbody.innerHTML = dishes.map(m => {
    const ps = platsMap[m.id];
    const isFromPrev = !!ps?.fromPreviousDate;
    const isBoisson  = m.categorie === 'Boissons';
    const prepare  = ps ? ps.quantitePrepare  : 0;
    // Pour un jour sans données : Boissons reportent leur quantiteRestante, autres partent à 0
    const restante = (ps && !isFromPrev) ? ps.quantiteRestante : prepare;
    const pct = prepare > 0 ? Math.round((restante / prepare) * 100) : 0;
    const etatColor = isFromPrev && prepare > 0 ? 'var(--gray)'
      : restante === 0 && prepare > 0 ? 'var(--danger)'
      : restante <= prepare * 0.3 ? 'var(--warning)'
      : 'var(--success)';
    const etatLabel = isFromPrev && prepare > 0 ? '📋 Report J-1'
      : restante === 0 && prepare > 0 ? '❌ Épuisé'
      : restante <= prepare * 0.3 && prepare > 0 ? '⚠️ Presque fini'
      : prepare === 0 ? '—' : '✅ Disponible';
    return `
    <tr${isFromPrev ? ' style="opacity:.85"' : ''}>
      <td data-label="Plat"><strong>${m.nom}</strong></td>
      <td data-label="Catégorie" style="color:var(--gray);font-size:.82rem">${m.categorie}</td>
      <td data-label="Préparé">
        <input type="number" min="0" class="plats-qty-input" id="plat-qty-${m.id}"
          value="${prepare}" data-menu-id="${m.id}" data-nom="${m.nom}" data-categorie="${m.categorie}"
          data-has-existing="${ps && !isFromPrev ? '1' : ''}">
      </td>
      <td data-label="Restant"><strong style="color:${etatColor}">${prepare > 0 ? (isFromPrev ? prepare : restante) : '—'}</strong>${prepare > 0 && !isFromPrev ? ` <small style="color:var(--gray)">(${pct}%)</small>` : ''}</td>
      <td data-label="État"><span style="color:${etatColor};font-weight:600">${etatLabel}</span></td>
    </tr>`;
  }).join('');

  // Bannière d'alerte pour les stocks épuisés du jour (uniquement les données du jour)
  const epuises = (platStocks || []).filter(p => !p.fromPreviousDate && p.quantiteRestante === 0 && p.quantitePrepare > 0);
  const banner = document.getElementById('plats-alert-banner');
  if (banner) {
    if (epuises.length > 0) {
      banner.style.display = '';
      banner.innerHTML = `<i class="fas fa-exclamation-circle"></i> Stock épuisé : ${epuises.map(p => `<strong>${p.nom}</strong>`).join(', ')}`;
    } else {
      banner.style.display = 'none';
    }
  }
}

async function saveStocksPlats() {
  const date = document.getElementById('plats-date').value;
  const inputs = document.querySelectorAll('.plats-qty-input');
  const plats = [];
  inputs.forEach(inp => {
    const qty = parseInt(inp.value, 10);
    const isBoisson = inp.dataset.categorie === 'Boissons';
    const hasExisting = inp.dataset.hasExisting === '1';
    // Sauvegarder si qty > 0, ou si Boisson avec données existantes (permet d'enregistrer "épuisé" = 0)
    if (!isNaN(qty) && (qty > 0 || (isBoisson && hasExisting))) {
      plats.push({
        menuItemId: inp.dataset.menuId,
        nom: inp.dataset.nom,
        categorie: inp.dataset.categorie,
        quantitePrepare: qty,
      });
    }
  });

  if (plats.length === 0) { toast('Aucune donnée à enregistrer', 'warning'); return; }
  showLoader();
  const res = await api('/api/stocks/plats', { method: 'POST', body: JSON.stringify({ plats, date }) });
  hideLoader();
  if (res?.message) {
    toast(res.message, 'success');
    loadStocksPlats();
  } else {
    toast(res?.error || 'Erreur', 'error');
  }
}

async function loadStocks() {
  loadStocksPlats();
}

window.editStock = (id) => {
  const s = state.stocks.find(x => x.id === id);
  if (!s) return;
  document.getElementById('modal-stock-title').textContent = 'Modifier le stock';
  document.getElementById('stock-id').value       = s.id;
  document.getElementById('stock-nom').value      = s.nom;
  document.getElementById('stock-categorie').value= s.categorie;
  document.getElementById('stock-quantite').value = s.quantite;
  document.getElementById('stock-minimum').value  = s.minimum;
  document.getElementById('stock-unite').value    = s.unite;
  openModal('stock');
};

function openNewStock() {
  document.getElementById('modal-stock-title').textContent = 'Nouvel article de stock';
  document.getElementById('form-stock').reset();
  document.getElementById('stock-id').value    = '';
  document.getElementById('stock-unite').value = 'kg';
  openModal('stock');
}

async function saveStock() {
  const id = document.getElementById('stock-id').value;
  const body = {
    nom:       document.getElementById('stock-nom').value.trim(),
    categorie: document.getElementById('stock-categorie').value,
    quantite:  Number(document.getElementById('stock-quantite').value),
    minimum:   Number(document.getElementById('stock-minimum').value),
    unite:     document.getElementById('stock-unite').value.trim(),
  };
  if (!body.nom) { toast('Nom requis', 'warning'); return; }

  showLoader();
  const res = id
    ? await api(`/api/stocks/${id}`, { method: 'PUT',  body: JSON.stringify(body) })
    : await api('/api/stocks',        { method: 'POST', body: JSON.stringify(body) });
  hideLoader();

  if (res?.id || res?.nom) {
    toast(id ? 'Stock mis à jour' : 'Article ajouté', 'success');
    closeModal('stock');
    loadStocks();
  } else {
    toast(res?.error || 'Erreur', 'error');
  }
}

async function seedStocks() {
  if (!confirm('Initialiser les stocks avec les ingrédients par défaut ?')) return;
  showLoader();
  const res = await api('/api/stocks/seed', { method: 'POST', body: '{}' });
  hideLoader();
  if (res?.message) { toast(res.message, 'success'); loadStocks(); }
  else toast(res?.error || 'Erreur', 'error');
}

// ─── RAPPORTS ──────────────────────────────────────────

async function loadRapport() {
  const debut = document.getElementById('rapp-start').value;
  const fin   = document.getElementById('rapp-end').value;
  let url = '/api/stats/rapport?';
  if (debut) url += `debut=${debut}&`;
  if (fin)   url += `fin=${fin}`;

  showLoader();
  const data = await api(url);
  hideLoader();
  if (!data) return;

  document.getElementById('rapp-nombre').textContent = data.nombre ?? '—';
  document.getElementById('rapp-ca').textContent     = fmt(data.total) + ' FCFA';

  // Par statut
  document.getElementById('rapp-par-statut').innerHTML = `
    <li><span>✅ Payées</span><strong>${data.parStatut?.payee || 0}</strong></li>
    <li><span>⚠️ Partielles</span><strong>${data.parStatut?.partielle || 0}</strong></li>
    <li><span>Ticket moyen</span><strong>${fmt(data.moyenne)} FCFA</strong></li>
  `;

  // Par mode de paiement
  const parMode = data.parMode || {};
  document.getElementById('rapp-par-mode').innerHTML =
    Object.entries(parMode).map(([mode, total]) =>
      `<li><span>${mode}</span><strong>${fmt(total)} FCFA</strong></li>`
    ).join('') || '<li><span>Aucune donnée</span></li>';

  // Top plats
  const topPlats = data.topPlats || [];
  document.getElementById('rapp-top-plats').innerHTML =
    topPlats.map(p => `<li><span>${p.nom}</span><strong>${p.quantite} vendus</strong></li>`).join('')
    || '<li><span>Aucune donnée</span></li>';

  // Par catégorie
  const parCat = data.parCategorie || {};
  document.getElementById('rapp-par-categorie').innerHTML =
    Object.entries(parCat).sort((a, b) => b[1] - a[1]).map(([cat, total]) =>
      `<li><span>${cat}</span><strong>${fmt(total)} FCFA</strong></li>`
    ).join('') || '<li><span>Aucune donnée</span></li>';

  // Tableau détail
  const tbody = document.getElementById('rapport-factures-tbody');
  if (!data.factures || data.factures.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--gray)">Aucune facture pour cette période</td></tr>';
    return;
  }
  tbody.innerHTML = data.factures.map(f => `
    <tr>
      <td data-label="N°"><strong>${f.numero}</strong></td>
      <td data-label="Date" style="font-size:.8rem">${fmtDateOnly(f.date)}</td>
      <td data-label="Commande" style="font-size:.82rem;color:var(--gray)">${f.commandeNumero || '—'}</td>
      <td data-label="Articles" style="font-size:.82rem">${(f.items || []).length} article(s)</td>
      <td data-label="Total"><strong>${fmt(f.total)} FCFA</strong></td>
      <td data-label="Paiement" style="font-size:.82rem;color:var(--gray)">${f.modePaiement || '—'}</td>
      <td data-label="Statut">${badgeStatus(f.statut)}</td>
    </tr>`).join('');
}

function exportCSV() {
  const tbody = document.getElementById('rapport-factures-tbody');
  if (!tbody || !tbody.querySelectorAll('tr').length) { toast('Générez d\'abord le rapport', 'warning'); return; }

  const rows = [['N° Facture', 'Date', 'Commande', 'Articles', 'Total FCFA', 'Mode', 'Statut']];
  tbody.querySelectorAll('tr').forEach(tr => {
    rows.push(Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim()));
  });

  const csv = rows.map(r => r.map(v => `"${v}"`).join(';')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: `rapport-cookafrica-${today()}.csv` });
  a.click(); URL.revokeObjectURL(url);
}

// ─── UTILISATEURS ──────────────────────────────────────

async function loadUtilisateurs() {
  showLoader();
  const users = await api('/api/auth/utilisateurs');
  hideLoader();
  if (!users) return;
  state.utilisateurs = users;

  const roleLabels = { admin: 'Admin', caissiere: 'Caissière', serveur: 'Serveur', cuisiniere: 'Cuisinière', barman: 'Barman' };
  const roleColors = { admin: '#8B1A1A', caissiere: '#2C5F2E', serveur: '#9C27B0', cuisiniere: '#D4891A', barman: '#1565C0' };

  const tbody = document.getElementById('utilisateurs-tbody');
  if (users.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--gray)">Aucun utilisateur</td></tr>';
    return;
  }

  tbody.innerHTML = users.map(u => `
    <tr style="${!u.actif ? 'opacity:.5' : ''}">
      <td data-label="Prénom">${u.prenom || '—'}</td>
      <td data-label="Nom"><strong>${u.nom}</strong></td>
      <td data-label="Identifiant" style="font-size:.82rem;color:var(--gray)">${u.username}</td>
      <td data-label="Rôle"><span style="color:${roleColors[u.role] || '#666'};font-weight:700;font-size:.82rem">${roleLabels[u.role] || u.role}</span></td>
      <td data-label="Statut"><span class="badge-status ${u.actif ? 'disponible' : 'annulee'}">${u.actif ? '✅ Actif' : '❌ Inactif'}</span></td>
      <td data-label="Connexion" style="font-size:.78rem;color:var(--gray)">${u.lastLogin ? fmtDate(u.lastLogin) : 'Jamais'}</td>
      <td data-label="Actions">
        <button class="btn btn-secondary btn-sm" onclick="editUtilisateur('${u.id}')">
          <i class="fas fa-edit"></i>
        </button>
        ${u.id !== state.user?.id ? `
        <button class="btn btn-${u.actif ? 'danger' : 'success'} btn-sm"
          onclick="toggleUtilisateur('${u.id}',${u.actif})">
          <i class="fas fa-${u.actif ? 'user-slash' : 'user-check'}"></i>
        </button>` : '<span style="font-size:.72rem;color:var(--gray);padding:5px">(vous)</span>'}
      </td>
    </tr>`).join('');
}

function openNewUtilisateur() {
  document.getElementById('modal-utilisateur-title').textContent = 'Nouvel utilisateur';
  document.getElementById('form-utilisateur').reset();
  document.getElementById('utilisateur-id').value = '';
  document.getElementById('utilisateur-username').disabled = false;
  document.getElementById('utilisateur-password').required = true;
  document.getElementById('utilisateur-password-label').textContent = 'Mot de passe *';
  document.getElementById('utilisateur-password-hint').style.display = 'none';
  document.getElementById('utilisateur-actif-group').style.display = 'none';
  openModal('utilisateur');
}

window.editUtilisateur = (id) => {
  const u = state.utilisateurs.find(x => x.id === id);
  if (!u) return;
  document.getElementById('modal-utilisateur-title').textContent = 'Modifier l\'utilisateur';
  document.getElementById('utilisateur-id').value      = u.id;
  document.getElementById('utilisateur-prenom').value  = u.prenom || '';
  document.getElementById('utilisateur-nom').value     = u.nom;
  document.getElementById('utilisateur-username').value   = u.username;
  document.getElementById('utilisateur-username').disabled = true;
  document.getElementById('utilisateur-role').value    = u.role;
  document.getElementById('utilisateur-password').value   = '';
  document.getElementById('utilisateur-password').required = false;
  document.getElementById('utilisateur-password-label').textContent = 'Nouveau mot de passe';
  document.getElementById('utilisateur-password-hint').style.display = 'block';
  document.getElementById('utilisateur-actif-group').style.display = 'block';
  document.getElementById('utilisateur-actif').value = String(u.actif !== false);
  openModal('utilisateur');
};

async function saveUtilisateur() {
  const id       = document.getElementById('utilisateur-id').value;
  const prenom   = document.getElementById('utilisateur-prenom').value.trim();
  const nom      = document.getElementById('utilisateur-nom').value.trim();
  const username = document.getElementById('utilisateur-username').value.trim();
  const role     = document.getElementById('utilisateur-role').value;
  const password = document.getElementById('utilisateur-password').value;
  const actif    = document.getElementById('utilisateur-actif').value;

  if (!nom) { toast('Le nom est requis', 'warning'); return; }
  if (!id && (!username || !password)) { toast('Identifiant et mot de passe requis', 'warning'); return; }

  showLoader();
  let res;
  if (id) {
    const body = { prenom, nom, role, actif: actif === 'true' };
    if (password) body.password = password;
    res = await api(`/api/auth/utilisateurs/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  } else {
    res = await api('/api/auth/utilisateurs', {
      method: 'POST',
      body: JSON.stringify({ prenom, nom, username, password, role }),
    });
  }
  hideLoader();

  if (res?.message || res?.id) {
    toast(id ? 'Utilisateur mis à jour' : 'Utilisateur créé', 'success');
    closeModal('utilisateur');
    loadUtilisateurs();
  } else {
    toast(res?.error || 'Erreur', 'error');
  }
}

window.toggleUtilisateur = async (id, currentActif) => {
  const newActif = !currentActif;
  const u = state.utilisateurs.find(x => x.id === id);
  const label = newActif ? 'réactiver' : 'désactiver';
  if (!confirm(`${label.charAt(0).toUpperCase() + label.slice(1)} ${u?.nom || ''} ?`)) return;
  showLoader();
  const res = await api(`/api/auth/utilisateurs/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ actif: newActif }),
  });
  hideLoader();
  if (res?.message) {
    toast(`Utilisateur ${newActif ? 'réactivé' : 'désactivé'}`, newActif ? 'success' : 'warning');
    loadUtilisateurs();
  } else {
    toast(res?.error || 'Erreur', 'error');
  }
};

// ─── CONFIG WI-FI ──────────────────────────────────────

async function loadWifiConfig() {
  const data = await api('/api/wifi-config');
  if (!data) return;

  const toggle = document.getElementById('wifi-toggle');
  const status = document.getElementById('wifi-status');
  const currentIpEl = document.getElementById('wifi-current-ip');
  const listEl = document.getElementById('wifi-ips-list');
  if (!toggle || !status || !currentIpEl || !listEl) return;

  toggle.checked = data.enabled;
  status.textContent = data.enabled ? 'Activée' : 'Désactivée';
  status.style.color = data.enabled ? 'var(--success)' : 'var(--gray)';
  currentIpEl.textContent = data.currentIp || '—';

  if (!data.allowedIps || data.allowedIps.length === 0) {
    listEl.innerHTML = '<li style="color:var(--gray);font-size:.83rem">Aucune adresse enregistrée</li>';
  } else {
    listEl.innerHTML = data.allowedIps.map(ip => `
      <li style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">
        <span style="font-family:monospace;font-size:.88rem">${ip}</span>
        <button class="btn btn-danger btn-sm" onclick="removeWifiIp('${ip}')">
          <i class="fas fa-trash"></i>
        </button>
      </li>`).join('');
  }
}

async function toggleWifiRestriction() {
  const res = await api('/api/wifi-config/toggle', { method: 'PATCH' });
  if (res?.message) {
    toast(res.message, res.enabled ? 'success' : 'warning');
    loadWifiConfig();
  } else {
    toast(res?.error || 'Erreur', 'error');
    loadWifiConfig(); // remettre l'état du toggle
  }
}

async function addCurrentWifiIp() {
  const res = await api('/api/wifi-config/add', { method: 'POST', body: '{}' });
  if (res?.message) { toast(res.message, 'success'); loadWifiConfig(); }
  else toast(res?.error || 'Erreur', 'error');
}

async function addManualWifiIp() {
  const input = document.getElementById('wifi-manual-ip');
  const ip = input?.value.trim();
  if (!ip) { toast('Saisissez une adresse IP', 'warning'); return; }
  const res = await api('/api/wifi-config/add', { method: 'POST', body: JSON.stringify({ ip }) });
  if (res?.message) {
    toast(`${ip} ajoutée`, 'success');
    if (input) input.value = '';
    loadWifiConfig();
  } else {
    toast(res?.error || 'Erreur', 'error');
  }
}

window.removeWifiIp = async (ip) => {
  if (!confirm(`Supprimer ${ip} de la liste ?`)) return;
  const res = await api('/api/wifi-config/remove', { method: 'DELETE', body: JSON.stringify({ ip }) });
  if (res?.message) { toast('Adresse supprimée', 'warning'); loadWifiConfig(); }
  else toast(res?.error || 'Erreur', 'error');
};

// ─── SESSIONS ──────────────────────────────────────────

async function loadSessions() {
  showLoader();
  const debut    = document.getElementById('filter-sess-start')?.value || '';
  const fin      = document.getElementById('filter-sess-end')?.value   || '';
  const username = document.getElementById('filter-sess-user')?.value  || '';

  let url = '/api/auth/sessions?';
  if (debut)    url += `debut=${debut}&`;
  if (fin)      url += `fin=${fin}&`;
  if (username) url += `username=${username}`;

  const sessions = await api(url);
  hideLoader();
  if (!sessions) return;

  const logins  = sessions.filter(s => s.action === 'login');
  const logouts = sessions.filter(s => s.action === 'logout');
  const users   = [...new Set(sessions.map(s => s.username))];

  document.getElementById('sess-count-login').textContent  = logins.length;
  document.getElementById('sess-count-logout').textContent = logouts.length;
  document.getElementById('sess-count-users').textContent  = users.length;

  // Peupler le filtre utilisateurs
  const sel = document.getElementById('filter-sess-user');
  const currentVal = sel.value;
  sel.innerHTML = '<option value="">Tous les utilisateurs</option>' +
    users.map(u => `<option value="${u}" ${u === currentVal ? 'selected' : ''}>${u}</option>`).join('');

  const tbody = document.getElementById('sessions-tbody');
  if (sessions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--gray)">Aucune session</td></tr>';
    return;
  }

  const roleColors = { admin: '#8B1A1A', caissiere: '#2C5F2E', serveur: '#9C27B0', cuisiniere: '#D4891A', barman: '#1565C0' };
  tbody.innerHTML = sessions.map(s => `
    <tr>
      <td data-label="Date" style="font-size:.8rem">${fmtDate(s.timestamp)}</td>
      <td data-label="Identifiant"><strong>${s.username}</strong></td>
      <td data-label="Nom" style="font-size:.85rem">${s.nom || '—'}</td>
      <td data-label="Rôle"><span style="color:${roleColors[s.role] || '#666'};font-weight:700;font-size:.82rem">${s.role}</span></td>
      <td data-label="Action">
        <span style="display:inline-flex;align-items:center;gap:5px;font-size:.82rem;font-weight:600;color:${s.action === 'login' ? 'var(--success)' : 'var(--gray)'}">
          <i class="fas fa-${s.action === 'login' ? 'sign-in-alt' : 'sign-out-alt'}"></i>
          ${s.action === 'login' ? 'Connexion' : 'Déconnexion'}
        </span>
      </td>
      <td data-label="IP" style="font-size:.78rem;color:var(--gray)">${s.ip || '—'}</td>
    </tr>`).join('');
}

// ─── Notifications ─────────────────────────────────────

function fmtRelative(iso) {
  if (!iso) return '';
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60)   return 'À l\'instant';
  if (diff < 3600) return `il y a ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `il y a ${Math.floor(diff / 3600)} h`;
  return fmtDateOnly(iso);
}

async function loadNotifBadge() {
  const notifs = await api('/api/notifications');
  if (!notifs) return;
  const unread = notifs.filter(n => !n.lu).length;
  const badge = document.getElementById('notif-badge');
  if (unread > 0) {
    badge.textContent = unread > 9 ? '9+' : unread;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

async function loadNotifPanel() {
  const el = document.getElementById('notif-list');
  el.innerHTML = '<div class="notif-loading"><i class="fas fa-spinner fa-spin"></i> Chargement…</div>';

  const notifs = await api('/api/notifications');
  if (!notifs || notifs.length === 0) {
    el.innerHTML = '<div class="notif-loading"><i class="fas fa-check-circle" style="color:var(--success)"></i> Aucune notification</div>';
    return;
  }

  el.innerHTML = notifs.map(n => `
    <div class="notif-item${n.lu ? '' : ' notif-unread'}">
      <div class="notif-icon ${n.type}"><i class="fas fa-${n.icon || 'bell'}"></i></div>
      <div style="flex:1;min-width:0">
        <div class="notif-text-title">${n.titre}</div>
        <div class="notif-text-msg">${n.message}</div>
        <div style="font-size:.72rem;color:var(--gray);margin-top:2px">
          <i class="fas fa-user" style="margin-right:3px"></i>${n.createdBy}
          &nbsp;·&nbsp;${fmtRelative(n.createdAt)}
        </div>
      </div>
    </div>`).join('');

  // Marquer tout comme lu après affichage
  api('/api/notifications/read', { method: 'PATCH' }).then(() => loadNotifBadge());
}

async function markAllNotifsRead() {
  await api('/api/notifications/read', { method: 'PATCH' });
  loadNotifBadge();
  loadNotifPanel();
}

// ─── Modals ────────────────────────────────────────────

function openModal(name) {
  document.getElementById(`modal-${name}`)?.classList.remove('hidden');
}
function closeModal(name) {
  document.getElementById(`modal-${name}`)?.classList.add('hidden');
}

// ─── Service Worker ────────────────────────────────────

if ('serviceWorker' in navigator) {
  const forceSkip = worker => worker.postMessage('SKIP_WAITING');

  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
    .then(reg => {
      // Si un nouveau SW est déjà en attente, le forcer à s'activer immédiatement
      if (reg.waiting) forceSkip(reg.waiting);

      // Quand un nouveau SW s'installe pendant que la page est ouverte
      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            forceSkip(installing);
          }
        });
      });

      return reg.update();
    })
    .catch(() => {});

  // Quand le nouveau SW prend le contrôle, recharger pour avoir la dernière version
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    window.location.reload();
  });
}

window.addEventListener('online',  () => document.body.classList.remove('offline'));
window.addEventListener('offline', () => document.body.classList.add('offline'));

// ─── Event Listeners ───────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {

  updateOfflineBadge();
  await wakeUpServer();

  // Login
  document.getElementById('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = document.getElementById('login-btn');
    const err = document.getElementById('login-error');
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Connexion…';
    err.style.display = 'none';

    try {
      const res = await fetch(API + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: document.getElementById('login-username').value,
          password: document.getElementById('login-password').value,
        }),
      });
      const data = await res.json();
      if (data.token) {
        await loginFlow(data.token, data.user);
      } else {
        err.textContent = data.error === 'wifi_restricted'
          ? '⚠️ Accès refusé : vous devez être connecté au Wi-Fi de l\'entreprise'
          : (data.message || data.error || 'Identifiants invalides');
        err.style.display = 'block';
      }
    } catch {
      err.textContent = 'Impossible de contacter le serveur';
      err.style.display = 'block';
    } finally {
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Se connecter';
    }
  });

  // Logout
  document.getElementById('logout-btn').addEventListener('click', () => {
    if (confirm('Se déconnecter ?')) logout(true);
  });

  // Navigation
  document.querySelectorAll('.nav-item[data-page]').forEach(el => {
    el.addEventListener('click', () => {
      navigateTo(el.dataset.page);
      // Fermer la sidebar sur mobile
      document.getElementById('main-sidebar')?.classList.remove('open');
      document.getElementById('sidebar-overlay')?.classList.remove('visible');
    });
  });

  // Hamburger (mobile)
  document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
    document.getElementById('main-sidebar')?.classList.toggle('open');
    document.getElementById('sidebar-overlay')?.classList.toggle('visible');
  });
  document.getElementById('sidebar-overlay')?.addEventListener('click', () => {
    document.getElementById('main-sidebar')?.classList.remove('open');
    document.getElementById('sidebar-overlay')?.classList.remove('visible');
  });

  // Close modals via [data-modal] buttons
  document.querySelectorAll('[data-modal]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.modal));
  });

  // Close modal clicking overlay
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) {
        const id = overlay.id.replace('modal-', '');
        closeModal(id);
      }
    });
  });

  // Notifications
  document.getElementById('notif-btn').addEventListener('click', () => {
    const panel = document.getElementById('notif-panel');
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) loadNotifPanel();
  });
  document.getElementById('notif-close').addEventListener('click', () => {
    document.getElementById('notif-panel').classList.add('hidden');
  });
  document.getElementById('notif-mark-read').addEventListener('click', markAllNotifsRead);

  // ── Commandes ──
  document.getElementById('btn-new-commande').addEventListener('click', () => openNewCommande('sur-place'));
  document.getElementById('btn-new-commande-ligne')?.addEventListener('click', () => openNewCommande('en-ligne'));

  // ── Recherche plat (commande) ──
  const menuSearch   = document.getElementById('cmd-menu-search');
  const menuDropdown = document.getElementById('menu-search-dropdown');
  const menuClear    = document.getElementById('cmd-menu-clear');
  menuSearch.addEventListener('input', () => {
    const q = menuSearch.value.trim();
    menuClear.style.display = q ? 'block' : 'none';
    renderMenuDropdown(q);
  });
  menuSearch.addEventListener('focus', () => {
    if (state.menu.length) renderMenuDropdown(menuSearch.value.trim());
  });
  menuClear.addEventListener('click', () => {
    menuSearch.value = '';
    menuClear.style.display = 'none';
    menuDropdown.style.display = 'none';
    menuSearch.focus();
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('#menu-search-wrapper')) menuDropdown.style.display = 'none';
  });

  document.getElementById('btn-save-commande').addEventListener('click', saveCommande);
  document.getElementById('btn-filter-cmd').addEventListener('click', loadCommandes);
  document.getElementById('btn-editcmd-save').addEventListener('click', saveEditCommande);
  document.getElementById('editcmd-add-select').addEventListener('change', function () {
    const opt = this.options[this.selectedIndex];
    if (!opt.value) return;
    addToEditCommande(opt.value, opt.dataset.nom, Number(opt.dataset.prix), opt.dataset.cat);
    this.value = '';
  });

  // ── Cuisine ──
  document.getElementById('btn-refresh-cuisine').addEventListener('click', () => loadCuisine());
  document.getElementById('btn-sound-cuisine').addEventListener('click', () => enableSound('cuisine'));
  document.getElementById('btn-play-cuisine').addEventListener('click', () => { enableSound('cuisine', false); loadCuisine(true); });

  // ── Bar ──
  document.getElementById('btn-refresh-barman').addEventListener('click', () => loadBarman());
  document.getElementById('btn-sound-barman').addEventListener('click', () => enableSound('bar'));
  document.getElementById('btn-play-barman').addEventListener('click', () => { enableSound('bar', false); loadBarman(true); });

  updateSoundButtons();

  // ── Facturation ──
  document.getElementById('btn-new-facture').addEventListener('click', openNewFacture);
  document.getElementById('btn-save-new-facture').addEventListener('click', saveNewFacture);
  document.getElementById('btn-confirm-pay-facture').addEventListener('click', confirmPayFacture);
  document.getElementById('btn-toggle-pay-prices').addEventListener('click', togglePayFacturePrices);
  document.getElementById('btn-filter-fact').addEventListener('click', loadFactures);
  document.getElementById('btn-print-facture').addEventListener('click', printFacture);
  document.getElementById('btn-repair-numeros')?.addEventListener('click', repairNumeros);
  document.getElementById('btn-sound-facturation').addEventListener('click', () => enableSound('facturation'));
  document.getElementById('btn-play-facturation').addEventListener('click', () => { enableSound('facturation', false); checkFacturationReady(true); });
  document.getElementById('btn-generate-edit-code').addEventListener('click', generateEditCode);
  document.getElementById('btn-editfact-unlock').addEventListener('click', unlockEditFacture);
  document.getElementById('btn-editfact-save').addEventListener('click', saveEditFacture);
  document.getElementById('editfact-add-select').addEventListener('change', function () {
    const opt = this.options[this.selectedIndex];
    if (!opt.value) return;
    addToEditFacture(opt.value, opt.dataset.nom, Number(opt.dataset.prix), opt.dataset.cat);
    this.value = '';
  });

  // ── Menu ──
  document.getElementById('btn-new-plat').addEventListener('click', openNewPlat);
  document.getElementById('btn-save-plat').addEventListener('click', savePlat);
  document.getElementById('btn-seed-menu').addEventListener('click', seedMenu);
  document.getElementById('filter-menu-cat').addEventListener('change', () => renderMenu(state.menu));

  // ── Stocks ──
  document.getElementById('btn-save-plats-jour').addEventListener('click', saveStocksPlats);

  // ── Rapports ──
  document.getElementById('btn-load-rapport').addEventListener('click', loadRapport);
  document.getElementById('btn-export-csv').addEventListener('click', exportCSV);

  // ── Sessions ──
  document.getElementById('btn-filter-sessions').addEventListener('click', loadSessions);

  // ── Utilisateurs ──
  document.getElementById('btn-new-utilisateur')?.addEventListener('click', openNewUtilisateur);
  document.getElementById('btn-save-utilisateur')?.addEventListener('click', saveUtilisateur);

  // ── Config Wi-Fi ──
  document.getElementById('wifi-toggle')?.addEventListener('change', toggleWifiRestriction);
  document.getElementById('btn-add-wifi-ip')?.addEventListener('click', addCurrentWifiIp);
  document.getElementById('btn-add-wifi-manual-ip')?.addEventListener('click', addManualWifiIp);
  document.getElementById('wifi-manual-ip')?.addEventListener('keydown', e => { if (e.key === 'Enter') addManualWifiIp(); });

  // ── Restauration session ──
  // Vérifie le token côté serveur avant de restaurer la session.
  // Évite que le navigateur normal reste bloqué avec un token expiré.
  const savedToken = localStorage.getItem('ca_token');
  const savedUser  = localStorage.getItem('ca_user');
  if (savedToken && savedUser) {
    state.token = savedToken;
    const me = await api('/api/auth/me');
    if (me?.id) {
      await hideSplash();
      try {
        await loginFlow(savedToken, me, true);
      } catch {
        logout();
        hideLoader();
      }
    } else {
      await hideSplash();
      if (state.token) {
        state.token = null;
        localStorage.removeItem('ca_token');
        localStorage.removeItem('ca_user');
      }
      hideLoader();
    }
  } else {
    await hideSplash();
    hideLoader();
  }
});

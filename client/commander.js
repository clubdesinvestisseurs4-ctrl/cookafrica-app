// ══════════════════════════════════════════════════════
//  COOK AFRICA — Commande client (page publique, sans compte)
//  Vanilla JS — parle uniquement à /api/public/*
// ══════════════════════════════════════════════════════

// Configuration par site (multi-restaurant) — même table que client/app.js, à garder
// synchronisée (pas de module partagé entre les deux, aucun n'a de build step).
const SITE_DEFAULT = {
  apiUrl:   'https://cookafrica-api-667992371198.us-central1.run.app', // Cloud Run (us-central1)
  currency: { label: 'FCFA', locale: 'fr-FR' },
  siteId:   'cote-divoire',
};
const SITE_CONFIG = {
  'localhost': { apiUrl: 'http://localhost:3001', currency: SITE_DEFAULT.currency, siteId: 'cote-divoire' },
  '127.0.0.1': { apiUrl: 'http://localhost:3001', currency: SITE_DEFAULT.currency, siteId: 'cote-divoire' },
  'cookafrica-dubai.vercel.app': {
    apiUrl:   'https://cookafrica-api-dubai-667992371198.me-central1.run.app',
    currency: { label: 'USD', locale: 'en-US' },
    siteId:   'dubai',
  },
};
const SITE = SITE_CONFIG[window.location.hostname] || SITE_DEFAULT;
const API = SITE.apiUrl;
document.documentElement.lang = SITE.siteId === 'dubai' ? 'en' : 'fr';
document.documentElement.dataset.site = SITE.siteId;
setI18nLang(SITE.siteId === 'dubai' ? 'en' : 'fr');

applyI18n();
document.getElementById('pub-cart-back')?.setAttribute('aria-label', t('pub.retour'));
document.title = SITE.siteId === 'dubai' ? 'Cook Africa – Order' : 'Cook Africa – Commander';

// Wave (mobile money) n'opère pas aux Émirats arabes unis — le lien marchand est
// spécifique à la Côte d'Ivoire, donc invisible pour les clients du site Dubaï.
if (SITE.siteId === 'dubai') document.getElementById('pub-wave-pay')?.remove();

// Ordre d'affichage des rayons : mots-clés cherchés dans le nom de catégorie
// (insensible à la casse/accents approximatifs) plutôt qu'une liste exacte,
// pour rester correct même si le libellé exact change au menu (ex. "Plats (sauce)").
const CATEGORY_PRIORITY_KEYWORDS = ['plat', 'buffet', 'accompagnement', 'boisson'];
const ORDER_TTL_MS = 6 * 60 * 60 * 1000; // une commande suivie reste affichée 6h après rechargement
const POLL_MS = 8000;
const POLL_MAX_MS = 45 * 60 * 1000; // arrête le suivi automatique après 45 min d'inactivité

// Onglet épinglé : le filtrage par jour (joursDisponibles) ne s'applique QUE dans cet
// onglet. "Toutes" et les onglets de catégorie (Sauce, Buffet, Boissons…) affichent tout
// le catalogue, sans tenir compte du jour.
const PLAT_DU_JOUR = 'Plat du jour';

const state = {
  menu: [],
  panier: [],
  activeCat: PLAT_DU_JOUR,
  recherche: '',
  localisation: null, // { lat, lng } capturée via navigator.geolocation
  pollTimer: null,
  pollStartedAt: 0,
};

// Jours de la semaine dans l'ordre de Date#getDay() (0 = dimanche)
const JOURS_SEMAINE = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const todayKey = () => JOURS_SEMAINE[new Date().getDay()];
const todayLabel = () => todayKey().charAt(0).toUpperCase() + todayKey().slice(1);

// L'onglet "Plat du jour" se limite aux plats/sauces et accompagnements — le Buffet et les
// Boissons (ainsi que Desserts/Entrées) ne s'y affichent jamais, quel que soit le jour.
const PLAT_DU_JOUR_CATEGORIES = ['plats', 'sauce', 'accompagnement'];

// Un plat sans joursDisponibles (ou vide) est visible tous les jours dans l'onglet "Plat du
// jour" — c'est le cas de tous les plats existants tant que l'admin n'a rien restreint. Les
// accompagnements y figurent toujours, quel que soit leur jour configuré : ce sont les à-côtés
// du plat vedette du jour (riz, alloco…), pas des plats à restreindre par jour eux-mêmes.
function menuDuJour() {
  const today = todayKey();
  return state.menu.filter((m) => {
    const cat = (m.categorie || '').toLowerCase();
    if (!PLAT_DU_JOUR_CATEGORIES.some((c) => cat.includes(c))) return false;
    if (cat.includes('accompagnement')) return true;
    return !m.joursDisponibles?.length || m.joursDisponibles.includes(today);
  });
}

// Recherche libre demandée par le client : cherche dans TOUT le catalogue, sans tenir
// compte du jour ni de l'onglet actif, pour retrouver n'importe quel plat.
function rechercheDansMenu() {
  const q = state.recherche.trim().toLowerCase();
  if (!q) return state.menu;
  return state.menu.filter((m) => m.nom.toLowerCase().includes(q));
}

// ─── Utilitaires ────────────────────────────────────────

const fmt = (n) => `${Number(n || 0).toLocaleString(SITE.currency.locale)} ${SITE.currency.label}`;

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

let toastTimer = null;
function toast(message, type = 'info') {
  const el = document.getElementById('pub-toast');
  el.textContent = message;
  el.className = `pub-toast is-visible${type === 'error' ? ' is-error' : type === 'success' ? ' is-success' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 3200);
}

async function apiCall(path, opts = {}) {
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(API + path, {
      ...opts,
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    clearTimeout(tid);
    const data = await res.json().catch(() => null);
    if (!res.ok) return { error: data?.error || t('pub.erreur_statut', { status: res.status }) };
    return data;
  } catch {
    return { error: 'network' };
  }
}

function show(id) {
  ['pub-loading', 'pub-error', 'pub-screen-menu', 'pub-screen-cart', 'pub-screen-confirm']
    .forEach((s) => { document.getElementById(s).style.display = s === id ? '' : 'none'; });
}

// ─── Persistance locale (panier + commande en cours) ──

function savePanier() { sessionStorage.setItem('ca_pub_panier', JSON.stringify(state.panier)); }
function loadPanier() { try { return JSON.parse(sessionStorage.getItem('ca_pub_panier')) || []; } catch { return []; } }

function saveOrder(order) {
  sessionStorage.setItem('ca_pub_order', JSON.stringify({ ...order, savedAt: Date.now() }));
}
function loadOrder() {
  try {
    const o = JSON.parse(sessionStorage.getItem('ca_pub_order'));
    if (o && Date.now() - o.savedAt < ORDER_TTL_MS) return o;
  } catch { /* rien */ }
  return null;
}
function clearOrder() { sessionStorage.removeItem('ca_pub_order'); }

// ─── Chargement du menu (avec réveil Cloud Run si besoin) ──

async function loadMenu(onLoadingScreen) {
  const statusEl = document.getElementById('pub-loading-status');
  const delays = [0, 3000, 5000, 8000, 12000, 18000];

  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) {
      if (onLoadingScreen) statusEl.textContent = t('pub.demarrage_serveur');
      await new Promise((r) => setTimeout(r, delays[i]));
    }
    const res = await apiCall('/api/public/menu');
    if (Array.isArray(res)) {
      state.menu = res;
      return true;
    }
  }
  return false;
}

async function initMenuFlow() {
  show('pub-loading');
  const ok = await loadMenu(true);
  if (!ok) {
    document.getElementById('pub-error-msg').textContent = t('pub.erreur_chargement_full');
    show('pub-error');
    return;
  }
  renderCategories();
  renderMenu();
  show('pub-screen-menu');
}

document.getElementById('pub-retry-btn').addEventListener('click', initMenuFlow);

document.getElementById('pub-search').addEventListener('input', (e) => {
  state.recherche = e.target.value;
  renderCategories();
  renderMenu();
});

// ─── Catégories + menu ──────────────────────────────────

function categoryPriority(cat) {
  const norm = cat.toLowerCase();
  const idx = CATEGORY_PRIORITY_KEYWORDS.findIndex((k) => norm.includes(k));
  return idx === -1 ? CATEGORY_PRIORITY_KEYWORDS.length : idx;
}

// Liste actuellement pertinente : résultats de recherche si le client cherche quelque
// chose ; sinon le menu filtré par jour UNIQUEMENT dans l'onglet "Plat du jour" ; le
// catalogue complet (toutes catégories, tous les jours) dans "Toutes" et chaque onglet
// de catégorie — voir PLAT_DU_JOUR.
function listeActive() {
  if (state.recherche.trim()) return rechercheDansMenu();
  if (state.activeCat === PLAT_DU_JOUR) return menuDuJour();
  return state.menu;
}

// Catégories présentes dans une liste d'articles donnée, triées par priorité d'affichage.
function sortedCategories(items) {
  const present = [...new Set(items.map((m) => m.categorie || 'Autres'))];
  return present.sort((a, b) => {
    const pa = categoryPriority(a), pb = categoryPriority(b);
    return pa !== pb ? pa - pb : a.localeCompare(b, 'fr');
  });
}

// Catégories présentes dans TOUT le catalogue (pas seulement la vue active) : les onglets
// restent stables, même pour une catégorie vide dans "Plat du jour" aujourd'hui.
function orderedCategories() {
  return sortedCategories(state.menu);
}

function renderCategories() {
  const cats = orderedCategories();
  const nav = document.getElementById('pub-cats');
  nav.innerHTML = [PLAT_DU_JOUR, 'Toutes', ...cats].map((c) => `
    <button class="pub-cat-pill${state.activeCat === c ? ' is-active' : ''}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>
  `).join('');
  nav.querySelectorAll('.pub-cat-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeCat = btn.dataset.cat;
      renderCategories();
      renderMenu();
    });
  });
}

function qtyInPanier(id) {
  return state.panier.find((p) => p.menuItemId === id)?.quantite || 0;
}

function renderMenuStatus() {
  const statusEl = document.getElementById('pub-menu-status');
  if (!statusEl) return;
  if (state.recherche.trim()) {
    statusEl.textContent = t('pub.resultats_pour', { q: state.recherche.trim() });
  } else if (state.activeCat === PLAT_DU_JOUR) {
    statusEl.textContent = t('pub.selection_du', { jour: todayLabel() });
  } else {
    statusEl.textContent = '';
  }
}

function renderMenu() {
  renderMenuStatus();
  const active = listeActive();
  const cats = (state.activeCat === 'Toutes' || state.activeCat === PLAT_DU_JOUR)
    ? sortedCategories(active)
    : [state.activeCat];
  const list = document.getElementById('pub-menu-list');

  if (state.menu.length === 0) {
    list.innerHTML = `<p class="pub-empty"><i class="fas fa-utensils"></i><br>${t('pub.aucun_plat_dispo')}</p>`;
    return;
  }
  if (active.length === 0) {
    list.innerHTML = `<p class="pub-empty"><i class="fas fa-search"></i><br>${t('pub.aucun_plat_trouve')}</p>`;
    return;
  }

  list.innerHTML = cats.map((cat) => {
    const items = active.filter((m) => (m.categorie || 'Autres') === cat);
    if (items.length === 0) return '';
    if (cat.toLowerCase().includes('buffet')) items.sort((a, b) => a.prix - b.prix);
    const cards = items.map((m) => {
      const qty = qtyInPanier(m.id);
      return `
      <div class="pub-item-card${qty > 0 ? ' has-qty' : ''}" data-id="${m.id}">
        <div class="pub-item-info">
          <h3>${escapeHtml(m.nom)}</h3>
          ${m.description ? `<p>${escapeHtml(m.description)}</p>` : ''}
          <div class="pub-item-prix">${fmt(m.prix)}</div>
        </div>
        ${qty > 0
          ? `<div class="pub-stepper">
              <button class="pub-step-minus" data-id="${m.id}"><i class="fas fa-minus"></i></button>
              <span>${qty}</span>
              <button class="pub-step-plus" data-id="${m.id}"><i class="fas fa-plus"></i></button>
            </div>`
          : `<button class="pub-item-add" data-id="${m.id}"><i class="fas fa-plus"></i></button>`}
      </div>`;
    }).join('');
    return `<div class="pub-cat-title">${escapeHtml(cat)}</div>${cards}`;
  }).join('');

  list.querySelectorAll('.pub-item-add, .pub-step-plus').forEach((btn) => {
    btn.addEventListener('click', () => addToPanier(btn.dataset.id));
  });
  list.querySelectorAll('.pub-step-minus').forEach((btn) => {
    btn.addEventListener('click', () => removeFromPanier(btn.dataset.id));
  });
}

// ─── Panier ─────────────────────────────────────────────

function addToPanier(id) {
  const menuItem = state.menu.find((m) => m.id === id);
  if (!menuItem) return;
  const existing = state.panier.find((p) => p.menuItemId === id);
  if (existing) existing.quantite++;
  else state.panier.push({ menuItemId: id, nom: menuItem.nom, prix: menuItem.prix, quantite: 1, categorie: menuItem.categorie || '' });
  savePanier();
  renderMenu();
  renderCartBar();
}

function removeFromPanier(id) {
  const existing = state.panier.find((p) => p.menuItemId === id);
  if (!existing) return;
  existing.quantite--;
  if (existing.quantite <= 0) state.panier = state.panier.filter((p) => p.menuItemId !== id);
  savePanier();
  renderMenu();
  renderCartBar();
}

function panierTotal() { return state.panier.reduce((s, p) => s + p.prix * p.quantite, 0); }
function panierCount() { return state.panier.reduce((s, p) => s + p.quantite, 0); }

function renderCartBar() {
  const bar = document.getElementById('pub-cart-bar');
  const count = panierCount();
  bar.classList.toggle('is-visible', count > 0);
  document.getElementById('pub-cart-count').textContent = count;
  document.getElementById('pub-cart-total').textContent = fmt(panierTotal());
}

function renderCartScreen() {
  const container = document.getElementById('pub-cart-items');
  if (state.panier.length === 0) {
    container.innerHTML = `<p class="pub-empty">${t('pub.panier_vide')}</p>`;
  } else {
    container.innerHTML = state.panier.map((p) => `
      <div class="pub-cart-item">
        <div class="pub-cart-item-info">
          <strong>${p.quantite}x ${escapeHtml(p.nom)}</strong>
          <span>${fmt(p.prix)} ${t('pub.unite_suffix')}</span>
        </div>
        <strong>${fmt(p.prix * p.quantite)}</strong>
        <button class="pub-cart-item-remove" data-id="${p.menuItemId}" title="${t('pub.retirer')}"><i class="fas fa-trash"></i></button>
      </div>`).join('');
    container.querySelectorAll('.pub-cart-item-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.panier = state.panier.filter((p) => p.menuItemId !== btn.dataset.id);
        savePanier();
        renderCartScreen();
        renderCartBar();
      });
    });
  }
  document.getElementById('pub-cart-footer-total-val').textContent = fmt(panierTotal());
  updateSubmitState();
}

// Le bouton reste grisé tant que le panier n'est pas rempli et que prénom,
// nom, téléphone et localisation ne sont pas tous renseignés.
function updateSubmitState() {
  const prenom = document.getElementById('pub-cart-prenom').value.trim();
  const nom = document.getElementById('pub-cart-nom').value.trim();
  const telDigits = document.getElementById('pub-cart-tel').value.replace(/\D/g, '');
  const ready = state.panier.length > 0 && !!prenom && !!nom && telDigits.length >= 8 && !!state.localisation;
  document.getElementById('pub-submit-btn').disabled = !ready;
}

document.getElementById('pub-cart-bar-btn').addEventListener('click', () => {
  renderCartScreen();
  show('pub-screen-cart');
});
document.getElementById('pub-cart-back').addEventListener('click', () => show('pub-screen-menu'));

// ─── Coordonnées client (persistées pour la session) ────

function saveContact() {
  sessionStorage.setItem('ca_pub_contact', JSON.stringify({
    prenom: document.getElementById('pub-cart-prenom').value,
    nom: document.getElementById('pub-cart-nom').value,
    tel: document.getElementById('pub-cart-tel').value,
    localisation: state.localisation,
  }));
}
function loadContact() {
  try { return JSON.parse(sessionStorage.getItem('ca_pub_contact')) || null; } catch { return null; }
}

// ─── Localisation (obligatoire — géolocalisation navigateur) ──

const geolocBtn    = document.getElementById('pub-geoloc-btn');
const geolocLabel  = document.getElementById('pub-geoloc-btn-label');
const geolocStatus = document.getElementById('pub-geoloc-status');

function setGeolocUi(kind, html) {
  geolocBtn.classList.remove('is-loading', 'is-success', 'is-error');
  if (kind) geolocBtn.classList.add(kind);
  geolocStatus.className = `pub-geoloc-status${kind === 'is-error' ? ' is-error-text' : ''}`;
  geolocStatus.innerHTML = html || '';
}

function renderGeolocSuccess({ lat, lng }) {
  geolocLabel.textContent = t('pub.position_enregistree');
  const mapsUrl = `https://www.google.com/maps?q=${lat},${lng}`;
  setGeolocUi('is-success', `<i class="fas fa-check"></i> ${t('pub.position_capturee_prefix')} <a href="${mapsUrl}" target="_blank" rel="noopener">${t('pub.verifier_google_maps')}</a> · <button type="button" class="pub-geoloc-refresh-link" id="pub-geoloc-refresh">${t('pub.actualiser')}</button>`);
  document.getElementById('pub-geoloc-refresh')?.addEventListener('click', captureLocalisation);
}

function captureLocalisation() {
  if (!navigator.geolocation) {
    setGeolocUi('is-error', t('pub.geoloc_non_supportee'));
    return;
  }
  geolocLabel.textContent = t('pub.localisation_en_cours');
  setGeolocUi('is-loading', t('pub.autoriser_position'));

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.localisation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      saveContact();
      renderGeolocSuccess(state.localisation);
      updateSubmitState();
    },
    (err) => {
      state.localisation = null;
      geolocLabel.textContent = t('pub.partager_position');
      const messages = {
        1: t('pub.geoloc_err_1'),
        2: t('pub.geoloc_err_2'),
        3: t('pub.geoloc_err_3'),
      };
      setGeolocUi('is-error', messages[err.code] || t('pub.geoloc_err_default'));
      updateSubmitState();
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 300000 }
  );
}

geolocBtn.addEventListener('click', captureLocalisation);

['pub-cart-prenom', 'pub-cart-nom', 'pub-cart-tel'].forEach((id) => {
  document.getElementById(id).addEventListener('input', (e) => {
    e.target.classList.remove('pub-field-invalid');
    saveContact();
    updateSubmitState();
  });
});

// ─── Envoi de la commande ───────────────────────────────

document.getElementById('pub-submit-btn').addEventListener('click', async () => {
  if (state.panier.length === 0) { toast(t('pub.panier_vide_toast'), 'error'); return; }

  const prenomEl = document.getElementById('pub-cart-prenom');
  const nomEl    = document.getElementById('pub-cart-nom');
  const telEl    = document.getElementById('pub-cart-tel');
  const prenom = prenomEl.value.trim();
  const nom    = nomEl.value.trim();
  const tel    = telEl.value.trim();

  if (!prenom) { prenomEl.classList.add('pub-field-invalid'); prenomEl.focus(); toast(t('pub.indiquez_prenom'), 'error'); return; }
  if (!nom) { nomEl.classList.add('pub-field-invalid'); nomEl.focus(); toast(t('pub.indiquez_nom'), 'error'); return; }
  if (tel.replace(/\D/g, '').length < 8) { telEl.classList.add('pub-field-invalid'); telEl.focus(); toast(t('pub.indiquez_tel'), 'error'); return; }
  if (!state.localisation) {
    toast(t('pub.partagez_position'), 'error');
    geolocBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  saveContact();
  const btn = document.getElementById('pub-submit-btn');
  btn.disabled = true;
  btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${t('pub.envoi_en_cours')}`;

  const res = await apiCall('/api/public/commandes', {
    method: 'POST',
    body: JSON.stringify({
      items: state.panier.map((p) => ({ menuItemId: p.menuItemId, quantite: p.quantite })),
      prenom, nom, telephone: tel,
      localisation: state.localisation,
    }),
  });

  btn.disabled = false;
  btn.innerHTML = `<i class="fas fa-paper-plane"></i> ${t('pub.envoyer_commande')}`;

  if (res.error === 'network') { toast(t('pub.verifiez_connexion'), 'error'); return; }
  if (res.error) { toast(res.error, 'error'); return; }

  state.panier = [];
  savePanier();
  saveOrder(res);
  toast(t('pub.commande_envoyee_toast', { numero: res.numero }), 'success');
  showConfirmScreen(res);
});

// ─── Confirmation + suivi de statut ─────────────────────

function renderConfirmItems(order) {
  const itemsEl = document.getElementById('pub-confirm-items');
  itemsEl.innerHTML = (order.items || []).map((i) => `
    <div class="pub-ci-row"><span>${i.quantite}x ${escapeHtml(i.nom)}</span><span>${fmt(i.prix * i.quantite)}</span></div>
  `).join('');
  document.getElementById('pub-confirm-total').innerHTML = `<span>${t('pub.total')}</span><span>${fmt(order.total)}</span>`;
}

function applyStatutTrack(statut) {
  const track = document.getElementById('pub-status-track');
  const cancelled = document.getElementById('pub-status-cancelled');

  if (statut === 'annulee') {
    track.style.display = 'none';
    cancelled.style.display = '';
    return;
  }
  track.style.display = '';
  cancelled.style.display = 'none';

  const servie = statut === 'servie';
  track.querySelector('[data-statut="en-preparation"]').className = 'pub-status-step is-done';
  track.querySelector('[data-statut="servie"]').className = `pub-status-step${servie ? ' is-done' : ' is-active'}`;
}

function showConfirmScreen(order) {
  document.getElementById('pub-confirm-numero').textContent = order.numero;
  renderConfirmItems(order);
  applyStatutTrack(order.statut || 'en-preparation');
  show('pub-screen-confirm');
  startPolling(order.id);
}

function stopPolling() { clearInterval(state.pollTimer); state.pollTimer = null; }

function startPolling(id) {
  stopPolling();
  state.pollStartedAt = Date.now();
  state.pollTimer = setInterval(async () => {
    if (Date.now() - state.pollStartedAt > POLL_MAX_MS) { stopPolling(); return; }
    const res = await apiCall(`/api/public/commandes/${id}`);
    if (res?.statut) {
      applyStatutTrack(res.statut);
      saveOrder(res);
      if (res.statut === 'servie' || res.statut === 'annulee') stopPolling();
    }
  }, POLL_MS);
}

document.getElementById('pub-new-order-btn').addEventListener('click', () => {
  stopPolling();
  clearOrder();
  renderCategories();
  renderMenu();
  renderCartBar();
  show('pub-screen-menu');
});

// ─── Démarrage ──────────────────────────────────────────

(async function init() {
  state.panier = loadPanier();

  const savedContact = loadContact();
  if (savedContact) {
    document.getElementById('pub-cart-prenom').value = savedContact.prenom || '';
    document.getElementById('pub-cart-nom').value = savedContact.nom || '';
    document.getElementById('pub-cart-tel').value = savedContact.tel || '';
    if (savedContact.localisation) {
      state.localisation = savedContact.localisation;
      renderGeolocSuccess(state.localisation);
    }
  }

  const savedOrder = loadOrder();
  if (savedOrder) {
    showConfirmScreen(savedOrder);
    loadMenu(false).then((ok) => { if (ok) { renderCategories(); renderMenu(); renderCartBar(); } });
  } else {
    await initMenuFlow();
    renderCartBar();
  }
})();

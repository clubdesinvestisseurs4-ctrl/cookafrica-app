// ══════════════════════════════════════════════════════
//  COOK AFRICA — Application de gestion restaurant
//  Vanilla JS (ES modules) + Express API + Firebase
// ══════════════════════════════════════════════════════

const API = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? 'http://localhost:3001'
  : 'https://cookafrica-api.onrender.com'; // ← à remplacer par votre URL Render

const state = {
  token:   null,
  user:    null,
  menu:    [],
  commandes: [],
  factures:  [],
  stocks:    [],
  panier:    [],
  notifInterval:   null,
  cuisineInterval: null,
  dashInterval:    null,
};

// ─── Visibilité des pages par rôle ────────────────────
const PAGE_ROLES = {
  dashboard:   ['directeur', 'receptionniste', 'cuisinier'],
  commandes:   ['directeur', 'receptionniste'],
  cuisine:     ['directeur', 'cuisinier'],
  facturation: ['directeur', 'receptionniste'],
  menu:        ['directeur'],
  stocks:      ['directeur', 'cuisinier'],
  rapports:    ['directeur'],
  sessions:    ['directeur'],
};

const PAGE_TITLES = {
  dashboard:   'Dashboard',
  commandes:   'Commandes',
  cuisine:     'Écran Cuisine',
  facturation: 'Facturation',
  menu:        'Carte du Menu',
  stocks:      'Gestion des Stocks',
  rapports:    'Rapports & Statistiques',
  sessions:    'Journal des Sessions',
};

// ─── Utilitaires ──────────────────────────────────────

async function api(path, opts = {}) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(API + path, { signal: controller.signal, headers, ...opts });
    clearTimeout(tid);
    if (res.status === 401 || res.status === 403) { logout(); return null; }
    return res.json();
  } catch {
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

function logout() {
  if (state.token) api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  state.token = null; state.user = null;
  localStorage.removeItem('ca_token');
  localStorage.removeItem('ca_user');
  clearIntervals();
  document.getElementById('app-screen').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
}

function clearIntervals() {
  clearInterval(state.notifInterval);
  clearInterval(state.cuisineInterval);
  clearInterval(state.dashInterval);
}

async function loginFlow(token, user) {
  state.token = token;
  state.user  = user;
  localStorage.setItem('ca_token', token);
  localStorage.setItem('ca_user', JSON.stringify(user));

  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-screen').style.display   = 'flex';
  document.getElementById('sidebar-user-name').textContent = user.nom;
  document.getElementById('sidebar-user-role').textContent = user.role;

  applyRoleNav();
  navigateTo(defaultPage());
  startPolling();
}

function defaultPage() {
  const role = state.user?.role;
  if (role === 'cuisinier') return 'cuisine';
  return 'dashboard';
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
    dashboard:   loadDashboard,
    commandes:   loadCommandes,
    cuisine:     loadCuisine,
    facturation: loadFactures,
    menu:        loadMenu,
    stocks:      loadStocks,
    rapports:    () => {},
    sessions:    loadSessions,
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

// ─── Polling ────────────────────────────────────────────

function startPolling() {
  updateDateBadge();
  setInterval(updateDateBadge, 60_000);

  // Rafraichir le dashboard actif toutes les 30s
  state.dashInterval = setInterval(() => {
    if (state.currentPage === 'dashboard') loadDashboard();
  }, 30_000);

  // Cuisine auto-refresh toutes les 20s
  state.cuisineInterval = setInterval(() => {
    if (state.currentPage === 'cuisine') loadCuisine();
  }, 20_000);

  // Notifications (directeur uniquement) toutes les 25s
  if (state.user?.role === 'directeur') {
    loadNotifBadge();
    state.notifInterval = setInterval(loadNotifBadge, 25_000);
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
          ${c.tableNumero ? `<span style="color:var(--gray);font-size:.78rem"> – ${c.tableNumero}</span>` : ''}
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
  showLoader();
  const statut = document.getElementById('filter-cmd-statut')?.value || '';
  const date   = document.getElementById('filter-cmd-date')?.value   || '';
  let url = '/api/commandes?';
  if (statut) url += `statut=${statut}&`;
  if (date)   url += `date=${date}`;

  const [commandes, factures] = await Promise.all([api(url), api('/api/factures')]);
  hideLoader();
  if (!commandes) return;
  state.commandes = commandes;
  if (factures) state.factures = factures;

  const tbody = document.getElementById('commandes-tbody');
  if (commandes.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state" style="padding:32px"><i class="fas fa-list-alt"></i><p>Aucune commande</p></td></tr>';
    return;
  }

  tbody.innerHTML = commandes.map(c => {
    const items = (c.items || []).map(i => `${i.quantite}x ${i.nom}`).join(', ');
    const alreadyFactured = state.factures.some(f => f.commandeId === c.id);
    const canFacture = ['servie', 'prete'].includes(c.statut) && !alreadyFactured;
    const canCancel  = state.user?.role === 'directeur' && !['annulee', 'servie'].includes(c.statut);
    return `
    <tr>
      <td><strong>${c.numero}</strong></td>
      <td style="font-size:.78rem;color:var(--gray)">${fmtDate(c.createdAt)}</td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.82rem">${items}</td>
      <td><strong>${fmt(c.total)} FCFA</strong></td>
      <td style="color:var(--gray);font-size:.82rem">${c.tableNumero || '—'}</td>
      <td>${badgeStatus(c.statut)}</td>
      <td>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-secondary btn-sm" onclick="viewCommande('${c.id}')">
            <i class="fas fa-eye"></i>
          </button>
          ${canFacture ? `<button class="btn btn-accent btn-sm" onclick="openNewFactureForCmd('${c.id}')">
            <i class="fas fa-receipt"></i> Facturer
          </button>` : ''}
          ${canCancel ? `<button class="btn btn-danger btn-sm" onclick="annulerCommande('${c.id}','${c.numero}')">
            <i class="fas fa-times"></i>
          </button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
}

async function viewCommande(id) {
  const c = state.commandes.find(x => x.id === id);
  if (!c) return;

  const items = (c.items || []).map(i => `
    <div class="commande-item">
      <span><span class="commande-item-qty">${i.quantite}</span> ${i.nom}</span>
      <span>${fmt(i.sousTotal)} FCFA</span>
    </div>`).join('');

  document.getElementById('modal-detail-titre').textContent = `Commande ${c.numero}`;
  document.getElementById('modal-detail-body').innerHTML = `
    <div style="margin-bottom:12px">
      ${c.tableNumero ? `<p><strong>Table :</strong> ${c.tableNumero}</p>` : ''}
      ${c.note ? `<p style="color:var(--gray);font-size:.85rem;font-style:italic"><i class="fas fa-sticky-note"></i> ${c.note}</p>` : ''}
      <p><strong>Statut :</strong> ${badgeStatus(c.statut)}</p>
      <p style="font-size:.8rem;color:var(--gray)"><strong>Créée par :</strong> ${c.createdBy} – ${fmtDate(c.createdAt)}</p>
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

window.viewCommande = viewCommande;
window.annulerCommande = annulerCommande;

// ─── NOUVELLE COMMANDE (panier) ────────────────────────

async function openNewCommande() {
  if (state.menu.length === 0) {
    const menu = await api('/api/menu');
    if (menu) state.menu = menu;
  }
  state.panier = [];
  renderPanier();
  // Peupler le select menu avec les plats disponibles
  const sel = document.getElementById('cmd-menu-select');
  const menuDispo = state.menu.filter(m => m.disponible);
  sel.innerHTML = '<option value="">Sélectionner un plat…</option>' +
    ['Plats', 'Entrées', 'Desserts', 'Boissons'].map(cat => {
      const items = menuDispo.filter(m => m.categorie === cat);
      if (!items.length) return '';
      return `<optgroup label="${cat}">${items.map(m =>
        `<option value="${m.id}" data-prix="${m.prix}" data-nom="${m.nom}">${m.nom} – ${fmt(m.prix)} FCFA</option>`
      ).join('')}</optgroup>`;
    }).join('');
  document.getElementById('cmd-table').value = '';
  document.getElementById('cmd-note').value  = '';
  openModal('commande');
}

function addToPanier() {
  const sel = document.getElementById('cmd-menu-select');
  const opt = sel.selectedOptions[0];
  if (!opt || !opt.value) return;

  const id   = opt.value;
  const nom  = opt.dataset.nom;
  const prix = Number(opt.dataset.prix);
  const existing = state.panier.find(p => p.menuItemId === id);
  if (existing) { existing.quantite++; existing.sousTotal = existing.prix * existing.quantite; }
  else { state.panier.push({ menuItemId: id, nom, prix, quantite: 1, sousTotal: prix }); }
  renderPanier();
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
  const body = {
    items:       state.panier,
    note:        document.getElementById('cmd-note').value.trim(),
    tableNumero: document.getElementById('cmd-table').value.trim(),
  };
  showLoader();
  const res = await api('/api/commandes', { method: 'POST', body: JSON.stringify(body) });
  hideLoader();
  if (res?.id) {
    toast(`Commande ${res.numero} envoyée en cuisine !`, 'success');
    closeModal('commande');
    loadCommandes();
  } else {
    toast(res?.error || 'Erreur lors de la création', 'error');
  }
}

// ─── CUISINE ───────────────────────────────────────────

async function loadCuisine() {
  const commandes = await api('/api/commandes/cuisine');
  const grid = document.getElementById('cuisine-grid');
  const count = document.getElementById('cuisine-count');

  if (!commandes || commandes.length === 0) {
    grid.innerHTML = '<div class="empty-state"><i class="fas fa-check-circle" style="color:var(--success)"></i><p>Aucune commande en cours – tout est calme !</p></div>';
    if (count) count.textContent = '0 commande';
    return;
  }

  if (count) count.textContent = `${commandes.length} commande(s) en cours`;

  grid.innerHTML = commandes.map(c => {
    const minutesAgo = Math.floor((Date.now() - new Date(c.createdAt).getTime()) / 60000);
    const items = (c.items || []).map(i => `
      <div class="commande-item">
        <span><span class="commande-item-qty">${i.quantite}</span> ${i.nom}</span>
        <span style="color:var(--gray);font-size:.78rem">${fmt(i.prix)} FCFA</span>
      </div>`).join('');

    const actionBtn = c.statut === 'en-attente'
      ? `<button class="btn btn-warning btn-sm" onclick="updateStatutCommande('${c.id}','en-preparation')">
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
          ${c.tableNumero ? `<div class="commande-table"><i class="fas fa-chair"></i> ${c.tableNumero}</div>` : ''}
        </div>
        <div style="text-align:right">
          ${badgeStatus(c.statut)}
          <div class="commande-time">${minutesAgo < 1 ? 'À l\'instant' : `il y a ${minutesAgo} min`}</div>
        </div>
      </div>
      <div class="commande-items">${items}</div>
      ${c.note ? `<div class="commande-note"><i class="fas fa-sticky-note"></i> ${c.note}</div>` : ''}
      <div class="commande-total">${fmt(c.total)} FCFA</div>
      <div class="commande-actions">${actionBtn}</div>
    </div>`;
  }).join('');
}

window.updateStatutCommande = async (id, statut) => {
  const res = await api(`/api/commandes/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ statut }),
  });
  if (res?.id) {
    const msgs = { 'en-preparation': 'Préparation démarrée !', 'prete': 'Commande marquée comme prête !' };
    toast(msgs[statut] || 'Statut mis à jour', 'success');
    loadCuisine();
  }
};

// ─── FACTURATION ───────────────────────────────────────

async function loadFactures() {
  showLoader();
  const debut  = document.getElementById('filter-fact-start')?.value || '';
  const fin    = document.getElementById('filter-fact-end')?.value   || '';
  const statut = document.getElementById('filter-fact-statut')?.value || '';

  let url = '/api/factures?';
  if (debut)  url += `debut=${debut}&`;
  if (fin)    url += `fin=${fin}&`;
  if (statut) url += `statut=${statut}`;

  const factures = await api(url);
  hideLoader();
  if (!factures) return;
  state.factures = factures;

  const tbody = document.getElementById('factures-tbody');
  if (factures.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--gray)">Aucune facture</td></tr>';
    return;
  }

  tbody.innerHTML = factures.map(f => {
    const nbArticles = (f.items || []).length;
    const canPay     = f.statut === 'partielle';
    return `
    <tr>
      <td><strong>${f.numero}</strong></td>
      <td style="font-size:.8rem">${fmtDateOnly(f.date)}</td>
      <td style="font-size:.82rem;color:var(--gray)">${f.commandeNumero || '—'}</td>
      <td style="font-size:.82rem">${nbArticles} article(s)</td>
      <td><strong>${fmt(f.total)} FCFA</strong></td>
      <td style="color:${f.reste > 0 ? 'var(--danger)' : 'var(--success)'};font-weight:700">${fmt(f.reste)} FCFA</td>
      <td style="font-size:.82rem;color:var(--gray)">${f.modePaiement || '—'}</td>
      <td>${badgeStatus(f.statut)}</td>
      <td>
        <div style="display:flex;gap:6px">
          <button class="btn btn-secondary btn-sm" onclick="aperçuFacture('${f.id}')">
            <i class="fas fa-print"></i>
          </button>
          ${canPay ? `<button class="btn btn-success btn-sm" onclick="openPayFacture('${f.id}','${fmt(f.reste)}')">
            <i class="fas fa-check"></i> Payer
          </button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
}

function openNewFacture() {
  const cmdsEligibles = state.commandes.filter(c =>
    ['servie', 'prete'].includes(c.statut) && !state.factures.some(f => f.commandeId === c.id)
  );
  const sel = document.getElementById('new-facture-commande');
  sel.innerHTML = '<option value="">Sélectionner une commande…</option>' +
    cmdsEligibles.map(c => `<option value="${c.id}">${c.numero} – ${fmt(c.total)} FCFA${c.tableNumero ? ' – ' + c.tableNumero : ''}</option>`).join('');
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
  document.getElementById('pay-facture-id').value = id;
  document.getElementById('pay-facture-info').textContent = `Reste à payer : ${reste} FCFA`;
  openModal('pay-facture');
};

async function confirmPayFacture() {
  const id   = document.getElementById('pay-facture-id').value;
  const mode = document.getElementById('pay-facture-mode').value;
  showLoader();
  const res = await api(`/api/factures/${id}/pay`, {
    method: 'PUT',
    body: JSON.stringify({ modePaiement: mode }),
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

  const items = (f.items || []).map(i => `
    <tr>
      <td>${i.nom}</td>
      <td style="text-align:center">${i.quantite}</td>
      <td style="text-align:right">${fmt(i.prix)}</td>
      <td style="text-align:right"><strong>${fmt(i.sousTotal)}</strong></td>
    </tr>`).join('');

  document.getElementById('facture-print-area').innerHTML = `
    <div class="facture-print">
      <div class="facture-print-header">
        <h2><i class="fas fa-utensils"></i> COOK AFRICA</h2>
        <p>Restaurant – Gestion Interne</p>
        <p style="margin-top:6px;font-size:.9rem"><strong>FACTURE N° ${f.numero}</strong></p>
        <p style="font-size:.78rem;color:var(--gray)">Date : ${fmtDateOnly(f.date)}</p>
        ${f.tableNumero ? `<p style="font-size:.78rem"><strong>Table :</strong> ${f.tableNumero}</p>` : ''}
        ${f.commandeNumero ? `<p style="font-size:.78rem;color:var(--gray)">Commande : ${f.commandeNumero}</p>` : ''}
      </div>
      <table class="facture-items">
        <thead><tr><th>Article</th><th>Qté</th><th>Prix unit.</th><th>Sous-total</th></tr></thead>
        <tbody>${items}</tbody>
      </table>
      <table class="facture-totaux">
        <tr><td>Sous-total</td><td>${fmt(f.sousTotal)} FCFA</td></tr>
        <tr><td>TVA (18%)</td><td>${fmt(f.tva)} FCFA</td></tr>
        <tr class="facture-total-final">
          <td><strong>TOTAL</strong></td>
          <td><strong>${fmt(f.total)} FCFA</strong></td>
        </tr>
        ${f.reste > 0 ? `<tr><td style="color:var(--danger)"><strong>RESTE À PAYER</strong></td><td style="color:var(--danger)"><strong>${fmt(f.reste)} FCFA</strong></td></tr>` : `<tr><td style="color:var(--success)"><strong>PAYÉE</strong></td><td style="color:var(--success)"><strong>✓</strong></td></tr>`}
      </table>
      <div style="margin-top:16px;padding-top:12px;border-top:2px dashed var(--border);text-align:center;font-size:.8rem;color:var(--gray)">
        <p>Mode de paiement : <strong>${f.modePaiement}</strong></p>
        <p style="margin-top:6px">Merci de votre visite !</p>
        <p style="font-size:.7rem;margin-top:4px">Cook Africa – Bonne dégustation</p>
      </div>
    </div>`;

  openModal('apercu-facture');
};

function printFacture() {
  const content = document.getElementById('facture-print-area').innerHTML;
  const w = window.open('', '_blank');
  w.document.write(`<!DOCTYPE html><html><head><title>Facture Cook Africa</title>
    <style>
      body { font-family: Arial, sans-serif; max-width: 480px; margin: 20px auto; font-size: 13px; }
      h2 { color: #8B1A1A; } p { margin: 3px 0; }
      .facture-print-header { text-align: center; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 2px dashed #ccc; }
      .facture-items { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
      .facture-items th { background: #8B1A1A; color: white; padding: 6px; text-align: left; }
      .facture-items td { padding: 6px; border-bottom: 1px solid #eee; }
      .facture-totaux { margin-left: auto; width: 200px; }
      .facture-totaux td { padding: 4px; }
      .facture-totaux td:last-child { text-align: right; font-weight: bold; }
    </style>
  </head><body>${content}</body></html>`);
  w.document.close();
  w.print();
}

// ─── MENU ──────────────────────────────────────────────

async function loadMenu() {
  showLoader();
  const menu = await api('/api/menu');
  hideLoader();
  if (!menu) return;
  state.menu = menu;
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
          ${state.user?.role === 'directeur' ? `
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

async function loadStocks() {
  showLoader();
  const [stocks, alerts] = await Promise.all([
    api('/api/stocks'),
    api('/api/stocks/alerts'),
  ]);
  hideLoader();
  if (!stocks) return;
  state.stocks = stocks;

  // Alertes
  const alertsEl = document.getElementById('stock-alerts-list');
  if (!alerts || alerts.length === 0) {
    alertsEl.innerHTML = '<p style="color:var(--success);font-size:.85rem"><i class="fas fa-check"></i> Tous les stocks sont suffisants</p>';
  } else {
    alertsEl.innerHTML = alerts.map(s => `
      <div class="alert-item">
        <i class="fas fa-exclamation-triangle"></i>
        <span>${s.nom} : <strong>${s.quantite}</strong> ${s.unite} (min. ${s.minimum})</span>
      </div>`).join('');
  }

  // Table
  const tbody = document.getElementById('stocks-tbody');
  if (stocks.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--gray)">Aucun article en stock</td></tr>';
    return;
  }

  tbody.innerHTML = stocks.map(s => {
    const isBas = s.quantite < s.minimum;
    return `
    <tr style="${isBas ? 'background:#fff5f5' : ''}">
      <td><strong>${s.nom}</strong></td>
      <td style="color:var(--gray);font-size:.82rem">${s.categorie}</td>
      <td><strong style="color:${isBas ? 'var(--danger)' : 'var(--dark)'}">${s.quantite}</strong></td>
      <td style="color:var(--gray)">${s.minimum}</td>
      <td style="color:var(--gray);font-size:.82rem">${s.unite}</td>
      <td><span class="badge-status ${isBas ? 'bas' : 'disponible'}">${isBas ? '⚠️ Stock bas' : '✅ OK'}</span></td>
      <td>
        <button class="btn btn-secondary btn-sm" onclick="editStock('${s.id}')">
          <i class="fas fa-edit"></i> Modifier
        </button>
      </td>
    </tr>`;
  }).join('');
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
      <td><strong>${f.numero}</strong></td>
      <td style="font-size:.8rem">${fmtDateOnly(f.date)}</td>
      <td style="font-size:.82rem;color:var(--gray)">${f.commandeNumero || '—'}</td>
      <td style="font-size:.82rem">${(f.items || []).length} article(s)</td>
      <td><strong>${fmt(f.total)} FCFA</strong></td>
      <td style="font-size:.82rem;color:var(--gray)">${f.modePaiement || '—'}</td>
      <td>${badgeStatus(f.statut)}</td>
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

  const roleColors = { directeur: '#8B1A1A', receptionniste: '#2C5F2E', cuisinier: '#D4891A' };
  tbody.innerHTML = sessions.map(s => `
    <tr>
      <td style="font-size:.8rem;white-space:nowrap">${fmtDate(s.timestamp)}</td>
      <td><strong>${s.username}</strong></td>
      <td style="font-size:.85rem">${s.nom || '—'}</td>
      <td><span style="color:${roleColors[s.role] || '#666'};font-weight:700;font-size:.82rem">${s.role}</span></td>
      <td>
        <span style="display:inline-flex;align-items:center;gap:5px;font-size:.82rem;font-weight:600;color:${s.action === 'login' ? 'var(--success)' : 'var(--gray)'}">
          <i class="fas fa-${s.action === 'login' ? 'sign-in-alt' : 'sign-out-alt'}"></i>
          ${s.action === 'login' ? 'Connexion' : 'Déconnexion'}
        </span>
      </td>
      <td style="font-size:.78rem;color:var(--gray)">${s.ip || '—'}</td>
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
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

window.addEventListener('online',  () => document.body.classList.remove('offline'));
window.addEventListener('offline', () => document.body.classList.add('offline'));

// ─── Event Listeners ───────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {

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
        err.textContent = data.error || 'Identifiants invalides';
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
    if (confirm('Se déconnecter ?')) logout();
  });

  // Navigation
  document.querySelectorAll('.nav-item[data-page]').forEach(el => {
    el.addEventListener('click', () => navigateTo(el.dataset.page));
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
  document.getElementById('btn-new-commande').addEventListener('click', openNewCommande);
  document.getElementById('btn-add-to-panier').addEventListener('click', addToPanier);
  document.getElementById('btn-save-commande').addEventListener('click', saveCommande);
  document.getElementById('btn-filter-cmd').addEventListener('click', loadCommandes);

  // ── Cuisine ──
  document.getElementById('btn-refresh-cuisine').addEventListener('click', loadCuisine);

  // ── Facturation ──
  document.getElementById('btn-new-facture').addEventListener('click', openNewFacture);
  document.getElementById('btn-save-new-facture').addEventListener('click', saveNewFacture);
  document.getElementById('btn-confirm-pay-facture').addEventListener('click', confirmPayFacture);
  document.getElementById('btn-filter-fact').addEventListener('click', loadFactures);
  document.getElementById('btn-print-facture').addEventListener('click', printFacture);

  // ── Menu ──
  document.getElementById('btn-new-plat').addEventListener('click', openNewPlat);
  document.getElementById('btn-save-plat').addEventListener('click', savePlat);
  document.getElementById('btn-seed-menu').addEventListener('click', seedMenu);
  document.getElementById('filter-menu-cat').addEventListener('change', () => renderMenu(state.menu));

  // ── Stocks ──
  document.getElementById('btn-new-stock').addEventListener('click', openNewStock);
  document.getElementById('btn-save-stock').addEventListener('click', saveStock);
  document.getElementById('btn-seed-stocks').addEventListener('click', seedStocks);

  // ── Rapports ──
  document.getElementById('btn-load-rapport').addEventListener('click', loadRapport);
  document.getElementById('btn-export-csv').addEventListener('click', exportCSV);

  // ── Sessions ──
  document.getElementById('btn-filter-sessions').addEventListener('click', loadSessions);

  // ── Restauration session ──
  const savedToken = localStorage.getItem('ca_token');
  const savedUser  = localStorage.getItem('ca_user');
  if (savedToken && savedUser) {
    try {
      loginFlow(savedToken, JSON.parse(savedUser));
    } catch { logout(); }
  } else {
    hideLoader();
  }
});

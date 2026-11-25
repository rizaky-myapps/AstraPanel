import { api, setUnauthorizedHandler } from './api.js';
import { $, ROLE_LABEL, html, icon, setHTML, statusOf } from './ui.js';
import { renderLogin } from './pages/login.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderNewApp } from './pages/new-app.js';
import { renderApp } from './pages/app.js';
import { renderSettings } from './pages/settings.js';
import { renderStorage } from './pages/storage.js';
import { renderHelp } from './pages/help.js';
import { isAdmin, onAppsChange, refreshApps, state } from './state.js';

const ROUTES = [
  { re: /^\/?$/, nav: 'dashboard', render: renderDashboard },
  { re: /^\/new$/, nav: 'new', render: renderNewApp },
  { re: /^\/apps\/([^/]+)(?:\/(\w+))?$/, nav: 'app', render: renderApp },
  { re: /^\/settings(?:\/([\w-]+)(?:\/([\w-]+))?)?$/, nav: 'settings', render: renderSettings },
  { re: /^\/storage(?:\/(.+))?$/, nav: 'storage', render: renderStorage },
  { re: /^\/aide(?:\/([\w-]+)(?:\/(.+))?)?$/, nav: 'aide', render: renderHelp },
];

let poller = null;
let updatePoller = null;
let currentPage = null;
let currentNav = null;
let update = null;

// Bandeau vert « mise à jour disponible » en haut de la page, pour les administrateurs,
// sur toutes les pages sauf les paramètres (qui affichent déjà la mise à jour).
function dismissedUpdate() {
  try {
    return localStorage.getItem('astra.update.dismissed');
  } catch {
    return null;
  }
}

function renderBanner() {
  const box = $('#banner');
  if (!box) return;
  const show = isAdmin() && update?.available && currentNav !== 'settings' && dismissedUpdate() !== update.latestVersion;
  if (!show) {
    box.textContent = '';
    return;
  }
  setHTML(
    box,
    html`<div class="update-banner" role="status">
      ${icon('arrowUpCircle')}
      <div class="update-banner-text">
        <b>Mise à jour disponible : AstraPanel ${update.latestVersion}</b>
        <span>Vous utilisez la version ${update.installed?.version || '?'}.</span>
      </div>
      <a class="btn btn-sm update-banner-cta" href="#/settings/mises-a-jour">Mettre à jour</a>
      <button class="btn btn-sm update-banner-later" data-later>Plus tard</button>
    </div>`,
  );
  box.querySelector('[data-later]').addEventListener('click', () => {
    try {
      localStorage.setItem('astra.update.dismissed', update.latestVersion);
    } catch {
      // stockage indisponible : le bandeau reviendra au prochain chargement
    }
    box.textContent = '';
  });
}

async function checkUpdate() {
  if (!isAdmin()) return;
  try {
    update = await api.get('/update');
  } catch {
    return;
  }
  renderBanner();
}

document.addEventListener('change', (e) => {
  const input = e.target.closest?.('[data-file-picker]');
  const name = input?.closest('.file-picker')?.querySelector('.file-name');
  if (!name) return;
  const file = input.files[0];
  name.textContent = file ? file.name : 'Aucun fichier choisi';
  name.classList.toggle('muted', !file);
});

function route() {
  if (!state.user) return;
  if (currentPage) {
    currentPage.active = false;
    currentPage.cleanups.forEach((fn) => fn());
  }
  const page = {
    active: true,
    cleanups: [],
    onCleanup(fn) {
      this.cleanups.push(fn);
    },
  };
  currentPage = page;
  $('.shell')?.classList.remove('menu-open');

  let path;
  try {
    path = decodeURI(location.hash.replace(/^#/, '')) || '/';
  } catch {
    path = '/';
  }
  const match = ROUTES.map((r) => ({ r, m: r.re.exec(path) })).find((x) => x.m);
  if (!match) {
    location.hash = '#/';
    return;
  }
  const params = match.m.slice(1);
  currentNav = match.r.nav;
  renderBanner();
  setActiveNav(match.r.nav, params[0]);
  const view = $('#view');
  if (match.r.nav !== 'app' || view.dataset.app !== params[0]) window.scrollTo(0, 0);
  view.dataset.app = match.r.nav === 'app' ? params[0] : '';
  Promise.resolve(match.r.render(view, page, ...params)).catch((err) => {
    if (page.active) setHTML(view, html`<div class="alert err">${icon('alert')}<div>${err.message}</div></div>`);
  });
}

function setActiveNav(nav, appId) {
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));
  document.querySelectorAll('.side-app').forEach((a) => a.classList.toggle('active', nav === 'app' && a.dataset.id === appId));
}

const brand = () => html`<a class="brand" href="#/">${icon('logo')}<span>Astra<b>Panel</b></span></a>`;

function renderShell() {
  const name = state.user.username;
  setHTML(
    $('#app'),
    html`<div class="shell">
      <aside class="sidebar">
        ${brand()}
        <nav class="nav">
          <a href="#/" data-nav="dashboard">${icon('grid')} Tableau de bord</a>
          <a href="#/new" data-nav="new">${icon('plus')} Nouvelle application</a>
          <a href="#/settings" data-nav="settings">${icon('sliders')} Paramètres</a>
          <a href="#/aide" data-nav="aide">${icon('book')} Aide</a>
        </nav>
        <div class="side-title">Applications</div>
        <div id="side-apps"></div>
        <div class="side-foot">
          <div class="avatar">${name.slice(0, 1).toUpperCase()}</div>
          <div class="truncate">
            <div class="truncate">${name}</div>
            <div class="faint side-role">${ROLE_LABEL[state.user.role] || ''}</div>
          </div>
          <span class="spacer"></span>
          <button class="btn btn-ghost btn-sm btn-icon" id="logout" title="Se déconnecter">${icon('logout')}</button>
        </div>
      </aside>
      <div>
        <div id="banner"></div>
        <header class="topbar">
          <button class="btn btn-ghost btn-icon" id="menu-btn" aria-label="Menu">${icon('menu')}</button>
          ${brand()}
        </header>
        <main class="main"><div class="view"><div id="view"></div></div></main>
      </div>
    </div>`,
  );
  $('#logout').addEventListener('click', async () => {
    await api.post('/auth/logout').catch(() => {});
    endSession();
  });
  $('#menu-btn').addEventListener('click', () => $('.shell').classList.add('menu-open'));
  $('.shell').addEventListener('click', (e) => {
    if (e.target === $('.shell')) $('.shell').classList.remove('menu-open');
  });
}

function renderSidebarApps() {
  const box = $('#side-apps');
  if (!box) return;
  const activeId = $('#view')?.dataset.app;
  setHTML(
    box,
    state.apps.length
      ? state.apps.map((app) => {
          const s = statusOf(app);
          return html`<a class="side-app ${app.id === activeId ? 'active' : ''}" data-id="${app.id}" href="#/apps/${app.id}"
            ><span class="dot ${s.cls}"></span><span class="truncate">${app.name}</span></a
          >`;
        })
      : html`<div class="side-empty faint">${isAdmin() ? 'Aucune application' : 'Aucune application pour l’instant : créez-en une, ou demandez à un administrateur de vous donner accès.'}</div>`,
  );
}

async function startSession(user) {
  state.user = user;
  renderShell();
  await refreshApps();
  clearInterval(poller);
  poller = setInterval(refreshApps, 3000);
  route();
  clearInterval(updatePoller);
  checkUpdate();
  // le panel vérifie GitHub toutes les 5 minutes ; on relit son résultat chaque minute
  updatePoller = setInterval(checkUpdate, 60_000);
}

function endSession(setupRequired = false) {
  state.user = null;
  state.apps = [];
  clearInterval(poller);
  clearInterval(updatePoller);
  update = null;
  if (currentPage) {
    currentPage.active = false;
    currentPage.cleanups.forEach((fn) => fn());
    currentPage = null;
  }
  renderLogin($('#app'), {
    setupRequired,
    onSuccess: (user) => {
      if (location.hash && location.hash !== '#/') location.hash = '#/';
      startSession(user);
    },
  });
}

async function boot() {
  onAppsChange(renderSidebarApps);
  setUnauthorizedHandler(() => {
    if (state.user) endSession();
  });
  window.addEventListener('hashchange', route);
  try {
    const status = await api.get('/auth/status');
    if (status.user) startSession(status.user);
    else endSession(status.setupRequired);
  } catch (err) {
    setHTML($('#app'), html`<div class="auth"><div class="alert err">${icon('alert')}<div>Panel injoignable : ${err.message}</div></div></div>`);
  }
}

boot();

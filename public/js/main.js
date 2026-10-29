import { api, setUnauthorizedHandler } from './api.js';
import { $, html, icon, setHTML, statusOf } from './ui.js';
import { renderLogin } from './pages/login.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderNewApp } from './pages/new-app.js';
import { renderApp } from './pages/app.js';
import { renderSettings } from './pages/settings.js';
import { onAppsChange, refreshApps, state } from './state.js';

const ROUTES = [
  { re: /^\/?$/, nav: 'dashboard', render: renderDashboard },
  { re: /^\/new$/, nav: 'new', render: renderNewApp },
  { re: /^\/apps\/([^/]+)(?:\/(\w+))?$/, nav: 'app', render: renderApp },
  { re: /^\/settings$/, nav: 'settings', render: renderSettings },
];

let poller = null;
let currentPage = null;

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
        </nav>
        <div class="side-title">Applications</div>
        <div id="side-apps"></div>
        <div class="side-foot">
          <div class="avatar">${name.slice(0, 1).toUpperCase()}</div>
          <span class="truncate">${name}</span>
          <span class="spacer"></span>
          <button class="btn btn-ghost btn-sm btn-icon" id="logout" title="Se déconnecter">${icon('logout')}</button>
        </div>
      </aside>
      <div>
        <header class="topbar">
          <button class="btn btn-ghost btn-icon" id="menu-btn" aria-label="Menu">${icon('menu')}</button>
          ${brand()}
        </header>
        <main class="main"><div class="view" id="view"></div></main>
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
      : html`<div class="side-app faint">Aucune application</div>`,
  );
}

async function startSession(user) {
  state.user = user;
  renderShell();
  await refreshApps();
  clearInterval(poller);
  poller = setInterval(refreshApps, 3000);
  route();
}

function endSession(setupRequired = false) {
  state.user = null;
  state.apps = [];
  clearInterval(poller);
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

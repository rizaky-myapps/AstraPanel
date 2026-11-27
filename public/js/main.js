import { api, setUnauthorizedHandler } from './api.js';
import { $, html, icon, initTooltips, setHTML, statusOf } from './ui.js';
import { renderLogin } from './pages/login.js';
import { startUpdateWatch, stopUpdateWatch } from './update-overlay.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderNewApp } from './pages/new-app.js';
import { renderApp } from './pages/app.js';
import { renderSettings } from './pages/settings.js';
import { renderStorage } from './pages/storage.js';
import { renderHelp } from './pages/help.js';
import { isAdmin, onAppsChange, refreshApps, state } from './state.js';
import { applyAppearance, initAppearance } from './theme.js';
import {
  initDesktopGlobals,
  menubarHTML,
  mountDesktop,
  refreshDesktop,
  refreshUser,
  setSystemInfo,
  setWindow,
  sidebarIcon,
  stopDesktop,
} from './desktop.js';
import { HOME, currentPath, initRouter, navigate, onNavigate } from './router.js';

initAppearance();

const ROUTES = [
  { re: /^\/(?:home)?$/, nav: 'dashboard', render: renderDashboard },
  { re: /^\/new$/, nav: 'new', render: renderNewApp },
  { re: /^\/apps\/([^/]+)(?:\/(\w+))?$/, nav: 'app', render: renderApp },
  { re: /^\/settings(?:\/([\w-]+)(?:\/([\w-]+))?)?$/, nav: 'settings', render: renderSettings },
  { re: /^\/storage(?:\/(.+))?$/, nav: 'storage', render: renderStorage },
  { re: /^\/aide(?:\/([\w-]+)(?:\/(.+))?)?$/, nav: 'aide', render: renderHelp },
];

let poller = null;
let updatePoller = null;
let currentPage = null;
let update = null;

// Notifications : mise à jour et tunnel (administrateurs), alimentation et chaleur de la machine (tous les comptes)
async function checkUpdate() {
  const system = await api.get('/system').catch(() => null);
  if (system) setSystemInfo({ system: { throttling: system.throttling, bootedAt: Math.round((Date.now() - system.uptime * 1000) / 60_000) } });
  if (!isAdmin()) return;
  const [u, tunnel] = await Promise.all([api.get('/update').catch(() => null), api.get('/tunnel').catch(() => null)]);
  if (u) update = u;
  setSystemInfo({ update, tunnel });
}

initTooltips();

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

  const path = currentPath();
  const match = ROUTES.map((r) => ({ r, m: r.re.exec(path) })).find((x) => x.m);
  if (!match) {
    navigate(HOME, { replace: true });
    return;
  }
  const params = match.m.slice(1);
  // page d'où l'on ouvre l'aide (elle n'est plus dans la barre latérale) : son bouton « Retour » y ramène
  if (match.r.nav !== 'aide') state.returnTo = path + location.search;
  setActiveNav(match.r.nav, params[0]);
  const view = $('#view');
  // le contenu défile dans la fenêtre : on revient en haut en changeant de page (pas d'onglet d'une même application)
  if (match.r.nav !== 'app' || view.dataset.app !== params[0]) $('#window-body')?.scrollTo(0, 0);
  view.dataset.app = match.r.nav === 'app' ? params[0] : '';
  setWindow(match.r.nav, params);
  Promise.resolve(match.r.render(view, page, ...params)).catch((err) => {
    if (page.active) setHTML(view, html`<div class="alert err">${icon('alert')}<div>${err.message}</div></div>`);
  });
}

function setActiveNav(nav, appId) {
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));
  document.querySelectorAll('.side-app').forEach((a) => a.classList.toggle('active', nav === 'app' && a.dataset.id === appId));
}

// Panneau latéral masquable (écrans larges) : le choix est retenu dans ce navigateur.
const SIDEBAR_KEY = 'astra.sidebar';
const wide = () => window.matchMedia('(min-width: 901px)').matches;
function sidebarHidden() {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === 'hidden';
  } catch {
    return false;
  }
}
function setSidebarHidden(hidden) {
  const shell = $('.shell');
  if (!shell) return;
  shell.classList.toggle('side-hidden', hidden);
  $('.sidebar').toggleAttribute('inert', hidden && wide());
  sidebarIcon(hidden);
  try {
    localStorage.setItem(SIDEBAR_KEY, hidden ? 'hidden' : 'shown');
  } catch {
    // stockage indisponible : le choix vaut pour cette page seulement
  }
  // les graphiques se redessinent à la nouvelle largeur
  setTimeout(() => window.dispatchEvent(new Event('resize')), 260);
}

async function logout() {
  await api.post('/auth/logout').catch(() => {});
  endSession();
}

function renderShell() {
  document.body.classList.add('os');
  setHTML(
    $('#app'),
    html`<div class="shell ${sidebarHidden() ? 'side-hidden' : ''}">
      <header class="menubar" id="menubar">${menubarHTML()}</header>
      <aside class="sidebar">
        <nav class="nav">
          <a href="/home" data-nav="dashboard">${icon('grid')} Tableau de bord</a>
          <a href="/settings" data-nav="settings">${icon('sliders')} Paramètres</a>
        </nav>
        <div class="side-title">
          <span>Applications</span>
          <a class="side-add" href="/new" data-nav="new" title="Nouvelle application" aria-label="Nouvelle application">${icon('plus')}</a>
        </div>
        <div id="side-apps"></div>
      </aside>
      <main class="main">
        <section class="window" id="window">
          <div class="window-body" id="window-body"><div class="view"><div id="view"></div></div></div>
        </section>
      </main>
    </div>`,
  );
  mountDesktop({
    onLogout: logout,
    // écran large : masque / affiche le panneau ; téléphone : l'ouvre par-dessus la page
    onToggleSidebar: () => (wide() ? setSidebarHidden(!$('.shell').classList.contains('side-hidden')) : $('.shell').classList.add('menu-open')),
  });
  sidebarIcon(sidebarHidden() && wide());
  window.matchMedia('(min-width: 901px)').addEventListener('change', () => sidebarIcon($('.shell')?.classList.contains('side-hidden')));
  if (sidebarHidden()) $('.sidebar').toggleAttribute('inert', wide());
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
          return html`<a class="side-app ${app.id === activeId ? 'active' : ''}" data-id="${app.id}" href="/apps/${app.id}"
            ><span class="dot ${s.cls}"></span><span class="truncate">${app.name}</span></a
          >`;
        })
      : html`<div class="side-empty faint">${isAdmin() ? 'Aucune application' : 'Aucune application pour l’instant : créez-en une, ou demandez à un administrateur de vous donner accès.'}</div>`,
  );
}

async function startSession(user) {
  state.user = user;
  applyAppearance(user.prefs);
  renderShell();
  await refreshApps();
  clearInterval(poller);
  poller = setInterval(refreshApps, 3000);
  route();
  clearInterval(updatePoller);
  checkUpdate();
  // le panel vérifie GitHub toutes les 5 minutes ; on relit son résultat chaque minute
  updatePoller = setInterval(checkUpdate, 60_000);
  // écran flouté pendant une mise à jour en cours (pour tous les comptes)
  startUpdateWatch();
}

function endSession(setupRequired = false) {
  document.body.classList.remove('os');
  state.user = null;
  state.apps = [];
  state.appsLoaded = false;
  clearInterval(poller);
  clearInterval(updatePoller);
  stopUpdateWatch();
  stopDesktop();
  update = null;
  if (currentPage) {
    currentPage.active = false;
    currentPage.cleanups.forEach((fn) => fn());
    currentPage = null;
  }
  renderLogin($('#app'), {
    setupRequired,
    onSuccess: (user) => {
      if (location.pathname !== HOME) history.replaceState(null, '', HOME);
      startSession(user);
    },
  });
}

async function boot() {
  onAppsChange(() => {
    renderSidebarApps();
    refreshDesktop();
  });
  initDesktopGlobals();
  window.addEventListener('astra:logout', () => state.user && logout());
  window.addEventListener('astra:user', () => {
    refreshUser();
    if (state.user?.prefs) applyAppearance(state.user.prefs);
  });
  setUnauthorizedHandler(() => {
    if (state.user) endSession();
  });
  initRouter();
  onNavigate(route);
  try {
    const status = await api.get('/auth/status');
    if (status.user) startSession(status.user);
    else endSession(status.setupRequired);
  } catch (err) {
    setHTML($('#app'), html`<div class="auth"><div class="alert err">${icon('alert')}<div>Panel injoignable : ${err.message}</div></div></div>`);
  }
}

boot();

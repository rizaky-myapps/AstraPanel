// Environnement de bureau façon système d'exploitation :
// - barre du haut : panneau latéral, logo, fenêtres ouvertes, recherche (Ctrl+K), notifications, thème, horloge, compte ;
// - chaque page s'affiche dans une fenêtre (fermer, réduire, agrandir) posée sur le fond d'écran ;
// - le tableau de bord est le « bureau » : ses widgets sont posés directement sur le fond d'écran.
import { api } from './api.js';
import { isAdmin, state } from './state.js';
import { applyAppearance, effectiveTheme } from './theme.js';
import { $, ROLE_LABEL, TYPE_INFO, avatar, html, icon, setHTML, statusOf } from './ui.js';

// fenêtres ouvertes : retenues par compte (deux comptes sur le même navigateur ne se mélangent pas)
const windowsKey = () => `astra.windows.${state.user?.id || ''}`;
const MAX_KEY = 'astra.window-max';
const MAX_WINDOWS = 6;

const APP_TABS = { console: 'Console', files: 'Fichiers', env: 'Variables', deploy: 'Déploiement', settings: 'Paramètres', users: 'Utilisateurs' };
const SETTINGS_TABS = {
  compte: 'Mon compte',
  utilisateurs: 'Utilisateurs',
  'mises-a-jour': 'Mises à jour',
  tunnel: 'Tunnel Cloudflare',
  general: 'Général',
  hardware: 'Hardware',
  journal: 'Journal',
};
const HELP_DOCS = { tutoriel: 'Installation et utilisation', cloudflare: 'Tunnel Cloudflare' };

const store = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // stockage indisponible : le réglage vaut pour cette page seulement
    }
  },
};

const sys = { update: null, tunnel: null };
let hooks = { onLogout: () => {}, onToggleSidebar: () => {} };
let current = null; // fenêtre affichée : { key, hash, title, icon, tone }
let windows = [];
let openPopover = null;

// ---- Fenêtre de la page affichée -----------------------------------------------------------------
// Décrit la fenêtre d'une page d'après son itinéraire (titre, icône, couleur de la tuile).
function describe(nav, params) {
  const [a, b] = params;
  if (nav === 'app') {
    const app = state.apps.find((x) => x.id === a);
    const type = TYPE_INFO[app?.type] || { icon: 'box' };
    const tab = APP_TABS[(location.hash.split('/')[3] || '').split('?')[0]];
    return { key: `app:${a}`, title: app?.name || 'Application', sub: tab, icon: type.icon, tone: app?.type || 'accent' };
  }
  if (nav === 'settings') return { key: 'settings', title: 'Paramètres', sub: SETTINGS_TABS[a || 'compte'], icon: 'sliders', tone: 'accent' };
  if (nav === 'new') return { key: 'new', title: 'Nouvelle application', icon: 'plus', tone: 'green' };
  if (nav === 'storage') return { key: 'storage', title: 'Stockage', icon: 'disk', tone: 'blue' };
  if (nav === 'aide') return { key: 'aide', title: 'Aide', sub: HELP_DOCS[a || 'tutoriel'], icon: 'book', tone: 'cyan' };
  return null; // bureau
}

export function setWindow(nav, params) {
  const shell = $('.shell');
  if (!shell) return;
  const info = describe(nav, params);
  shell.classList.toggle('desktop-mode', !info);
  current = info ? { ...info, hash: location.hash } : null;
  if (info) {
    // l'adresse peut être complétée par la page (onglet retenu) : on la relit juste après
    setTimeout(() => {
      if (current?.key !== info.key) return;
      current.hash = location.hash;
      const sub = describe(nav, params)?.sub;
      if (sub) current.sub = sub;
      remember(current);
      drawTitle();
    }, 0);
    remember(current);
  }
  drawTitle();
  drawWindows();
}

function drawTitle() {
  const title = $('#window-title');
  if (!title || !current) return;
  setHTML(
    title,
    html`<span class="window-icon tone-${current.tone}">${icon(current.icon)}</span><b class="truncate">${current.title}</b>${current.sub ? html`<span class="window-sub truncate">${current.sub}</span>` : ''}`,
  );
  document.title = `${current.title}${current.sub ? ` · ${current.sub}` : ''} — AstraPanel`;
}

// Fenêtres ouvertes (comme une barre des tâches) : on y revient en un clic
function remember(win) {
  const entry = { key: win.key, hash: win.hash, title: win.title, icon: win.icon, tone: win.tone };
  const i = windows.findIndex((w) => w.key === win.key);
  if (i >= 0) windows[i] = entry;
  else windows = [...windows, entry].slice(-MAX_WINDOWS);
  store.set(windowsKey(), windows);
}

function forget(key) {
  windows = windows.filter((w) => w.key !== key);
  store.set(windowsKey(), windows);
}

function drawWindows() {
  const box = $('#mb-windows');
  if (!box) return;
  // une application supprimée (ou plus accessible) disparaît de la barre
  const known = new Set(state.apps.map((a) => `app:${a.id}`));
  const visible = windows.filter((w) => !w.key.startsWith('app:') || known.has(w.key));
  setHTML(
    box,
    visible.map((w) => {
      const app = w.key.startsWith('app:') ? state.apps.find((a) => `app:${a.id}` === w.key) : null;
      const title = app?.name || w.title;
      return html`<a class="mb-window ${current?.key === w.key ? 'active' : ''}" href="${w.hash}" title="${title}">
        <span class="window-icon tone-${w.tone}">${icon(w.icon)}</span><span class="truncate">${title}</span>${app ? html`<span class="dot ${statusOf(app).cls}"></span>` : ''}
      </a>`;
    }),
  );
}

function windowAction(action) {
  if (action === 'max') {
    const max = !$('.shell').classList.contains('win-max');
    $('.shell').classList.toggle('win-max', max);
    store.set(MAX_KEY, max);
    drawMaxButton();
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
    return;
  }
  // réduire : retour au bureau, la fenêtre reste dans la barre ; fermer : elle en disparaît
  if (action === 'close' && current) forget(current.key);
  location.hash = '#/';
}

function drawMaxButton() {
  const button = $('[data-win="max"]');
  if (!button) return;
  const max = $('.shell').classList.contains('win-max');
  setHTML(button, icon(max ? 'minimize' : 'maximize'));
  button.title = max ? 'Taille normale' : 'Agrandir';
  button.setAttribute('aria-label', max ? 'Remettre la fenêtre à sa taille normale' : 'Agrandir la fenêtre');
}

// ---- Notifications --------------------------------------------------------------------------------
function notifications() {
  const out = [];
  for (const app of state.apps) {
    if (app.runtime.status === 'crashed') {
      out.push({ level: 'err', icon: 'alert', title: `${app.name} est planté`, text: 'Voir la console', href: `#/apps/${app.id}/console` });
    }
    if (app.runtime.busy) {
      out.push({ level: 'info', icon: 'refresh', title: `${app.name} : ${statusOf(app).label}`, text: 'Suivre dans la console', href: `#/apps/${app.id}/console` });
    }
    const hook = app.webhookLog?.[0];
    if (hook?.outcome === 'failed' && Date.now() - (hook.doneAt || hook.at) < 24 * 3600_000) {
      out.push({ level: 'err', icon: 'upload', title: `Échec du déploiement de ${app.name}`, text: hook.error || 'Voir l’onglet Déploiement', href: `#/apps/${app.id}/deploy` });
    }
  }
  if (isAdmin() && sys.update?.available) {
    out.push({ level: 'ok', icon: 'arrowUpCircle', title: `AstraPanel ${sys.update.latestVersion} est disponible`, text: 'Mettre à jour', href: '#/settings/mises-a-jour' });
  }
  const t = sys.tunnel;
  if (isAdmin() && t?.enabled && (t.binary || t.running) && !(t.running && (t.ready?.readyConnections || 0) > 0)) {
    out.push({ level: 'warn', icon: 'cloud', title: 'Tunnel Cloudflare déconnecté', text: 'Vos sites ne sont plus joignables depuis Internet', href: '#/settings/tunnel' });
  }
  return out;
}

export function refreshNotifications() {
  const list = notifications();
  const badge = $('#mb-notif-count');
  if (badge) {
    badge.textContent = String(list.length);
    badge.hidden = !list.length;
    badge.className = `mb-badge ${list.some((n) => n.level === 'err') ? 'err' : list.some((n) => n.level === 'warn') ? 'warn' : ''}`;
  }
  if (openPopover === 'notif') drawNotifications();
}

function drawNotifications() {
  const list = notifications();
  setHTML(
    $('#mb-popover'),
    html`<div class="popover-head"><b>Notifications</b><span class="faint">${list.length || ''}</span></div>
      ${list.length
        ? html`<ul class="notif-list">
            ${list.map(
              (n) => html`<li><a class="notif ${n.level}" href="${n.href}">
                <span class="notif-icon">${icon(n.icon)}</span>
                <span class="notif-text"><b>${n.title}</b><span>${n.text}</span></span>
              </a></li>`,
            )}
          </ul>`
        : html`<div class="popover-empty">${icon('check')} Tout fonctionne normalement</div>`}`,
  );
}

export function setSystemInfo(info) {
  Object.assign(sys, info);
  refreshNotifications();
}

// ---- Menu du compte -------------------------------------------------------------------------------
function drawUserMenu() {
  const u = state.user;
  const dark = effectiveTheme() === 'dark';
  setHTML(
    $('#mb-popover'),
    html`<div class="popover-user">
        ${avatar(u, 'lg')}
        <div class="truncate"><b class="truncate">${u.username}</b><span class="faint">${ROLE_LABEL[u.role]}</span></div>
      </div>
      <div class="popover-menu">
        <a href="#/settings/compte">${icon('user')} Mon compte</a>
        <button type="button" data-menu="theme">${icon(dark ? 'sun' : 'moon')} ${dark ? 'Thème clair' : 'Thème sombre'}</button>
        ${isAdmin() ? html`<a href="#/settings/utilisateurs">${icon('users')} Utilisateurs</a>` : ''}
        <a href="#/aide">${icon('book')} Aide</a>
        <button type="button" class="danger" data-menu="logout">${icon('logout')} Se déconnecter</button>
      </div>`,
  );
}

function drawUserButton() {
  const button = $('#mb-user');
  if (button && state.user) setHTML(button, avatar(state.user));
}

export function refreshUser() {
  drawUserButton();
  if (openPopover === 'user') drawUserMenu();
}

// ---- Fenêtres surgissantes de la barre (notifications, compte) -----------------------------------
function togglePopover(kind, anchor) {
  const box = $('#mb-popover');
  if (openPopover === kind) {
    closePopover();
    return;
  }
  openPopover = kind;
  box.hidden = false;
  box.dataset.kind = kind;
  if (kind === 'notif') drawNotifications();
  else drawUserMenu();
  const r = anchor.getBoundingClientRect();
  box.style.right = `${Math.max(8, window.innerWidth - r.right - 4)}px`;
  document.querySelectorAll('.mb-btn[aria-expanded], .mb-user[aria-expanded]').forEach((b) => b.setAttribute('aria-expanded', String(b === anchor)));
}

function closePopover() {
  openPopover = null;
  const box = $('#mb-popover');
  if (box) box.hidden = true;
  document.querySelectorAll('[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

async function toggleTheme() {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  applyAppearance({ ...state.user.prefs, theme: next });
  try {
    const { user } = await api.patch('/account/preferences', { theme: next });
    state.user = { ...state.user, ...user };
  } catch {
    // le choix reste appliqué sur cet appareil
  }
}

function drawThemeButton() {
  const button = $('#theme-toggle');
  if (!button) return;
  const dark = effectiveTheme() === 'dark';
  const label = dark ? 'Passer au thème clair' : 'Passer au thème sombre';
  setHTML(button, icon(dark ? 'sun' : 'moon'));
  button.title = label;
  button.setAttribute('aria-label', label);
  if (openPopover === 'user') drawUserMenu();
}

// ---- Horloge de la barre ---------------------------------------------------------------------------
const DAY = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
let clockTimer = null;
function tickClock() {
  const time = $('#mb-time');
  if (!time) return;
  const now = new Date();
  time.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  $('#mb-date').textContent = DAY.format(now);
  clearTimeout(clockTimer);
  clockTimer = setTimeout(tickClock, 60_000 - (Date.now() % 60_000) + 20);
}

// ---- Recherche (Ctrl+K) ----------------------------------------------------------------------------
const normalize = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

function searchItems() {
  const items = [];
  for (const app of state.apps) {
    const type = TYPE_INFO[app.type] || { icon: 'box', label: app.type };
    items.push({ group: 'Applications', icon: type.icon, tone: app.type, title: app.name, sub: `${type.label} · ${statusOf(app).label}`, href: `#/apps/${app.id}` });
  }
  const page = (title, href, ic, sub = '', tone = 'accent') => items.push({ group: 'Pages', icon: ic, tone, title, sub, href });
  page('Tableau de bord', '#/', 'grid', 'Bureau');
  page('Nouvelle application', '#/new', 'plus', 'Site ou bot Discord', 'green');
  for (const [id, label] of Object.entries(SETTINGS_TABS)) {
    if (id !== 'compte' && !isAdmin()) continue;
    page(label, `#/settings/${id}`, id === 'compte' ? 'user' : 'sliders', 'Paramètres');
  }
  if (isAdmin()) page('Stockage', '#/storage', 'disk', 'Disques et espace occupé', 'blue');
  page('Tutoriel d’installation et d’utilisation', '#/aide/tutoriel', 'book', 'Aide', 'cyan');
  page('Tutoriel du tunnel Cloudflare', '#/aide/cloudflare', 'cloud', 'Aide', 'cyan');
  items.push({ group: 'Actions', icon: effectiveTheme() === 'dark' ? 'sun' : 'moon', tone: 'accent', title: effectiveTheme() === 'dark' ? 'Passer au thème clair' : 'Passer au thème sombre', action: 'theme' });
  items.push({ group: 'Actions', icon: 'logout', tone: 'accent', title: 'Se déconnecter', action: 'logout' });
  return items;
}

let search = null;
export function openSearch() {
  if (search) return;
  closePopover();
  const el = document.createElement('div');
  el.className = 'spotlight-backdrop';
  setHTML(
    el,
    html`<div class="spotlight" role="dialog" aria-modal="true" aria-label="Rechercher">
      <label class="spotlight-input">${icon('search')}<input type="search" placeholder="Rechercher une application, une page, une action…" autocomplete="off" spellcheck="false" /><kbd>Échap</kbd></label>
      <div class="spotlight-results" role="listbox"></div>
    </div>`,
  );
  document.body.append(el);
  const input = el.querySelector('input');
  const results = el.querySelector('.spotlight-results');
  const all = searchItems();
  let shown = [];
  let selected = 0;
  const draw = () => {
    const q = normalize(input.value.trim());
    shown = q ? all.filter((i) => normalize(`${i.title} ${i.sub || ''} ${i.group}`).includes(q)) : all;
    selected = Math.min(selected, Math.max(0, shown.length - 1));
    let group = '';
    setHTML(
      results,
      shown.length
        ? shown.map((item, i) => {
            const head = item.group !== group ? html`<div class="spotlight-group">${(group = item.group)}</div>` : '';
            return html`${head}<button type="button" class="spotlight-item ${i === selected ? 'selected' : ''}" data-index="${i}" role="option" aria-selected="${i === selected}">
              <span class="window-icon tone-${item.tone}">${icon(item.icon)}</span>
              <span class="spotlight-text"><b>${item.title}</b>${item.sub ? html`<span>${item.sub}</span>` : ''}</span>
              ${icon('chevronRight')}
            </button>`;
          })
        : html`<div class="popover-empty">Aucun résultat</div>`,
    );
    results.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  };
  const run = (item) => {
    if (!item) return;
    closeSearch();
    if (item.action === 'theme') toggleTheme();
    else if (item.action === 'logout') hooks.onLogout();
    else location.hash = item.href;
  };
  input.addEventListener('input', () => {
    selected = 0;
    draw();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(1, shown.length);
      draw();
    }
    if (e.key === 'Enter') run(shown[selected]);
  });
  results.addEventListener('click', (e) => {
    const b = e.target.closest('[data-index]');
    if (b) run(shown[Number(b.dataset.index)]);
  });
  el.addEventListener('mousedown', (e) => {
    if (e.target === el) closeSearch();
  });
  search = el;
  draw();
  input.focus();
}

function closeSearch() {
  search?.remove();
  search = null;
}

// ---- Installation de la barre -----------------------------------------------------------------------
export function menubarHTML() {
  return html`<button class="mb-btn" id="side-toggle" title="Panneau latéral" aria-label="Afficher ou masquer le panneau latéral">${icon('panelClose')}</button>
    <a class="mb-brand" href="#/" title="Tableau de bord">${icon('logo')}<span>Astra<b>Panel</b></span></a>
    <nav class="mb-windows" id="mb-windows" aria-label="Fenêtres ouvertes"></nav>
    <span class="spacer"></span>
    <button class="mb-btn mb-search" id="mb-search" title="Rechercher (Ctrl+K)" aria-label="Rechercher">${icon('search')}<span>Rechercher</span><kbd>Ctrl K</kbd></button>
    <button class="mb-btn" id="mb-notif" title="Notifications" aria-label="Notifications" aria-expanded="false">${icon('bell')}<span class="mb-badge" id="mb-notif-count" hidden></span></button>
    <button class="mb-btn" id="theme-toggle"></button>
    <div class="mb-clock" aria-hidden="true"><span id="mb-date"></span><b id="mb-time"></b></div>
    <button class="mb-user" id="mb-user" title="Mon compte" aria-label="Menu du compte" aria-expanded="false"></button>
    <div class="mb-popover" id="mb-popover" hidden></div>`;
}

export function windowBarHTML() {
  return html`<div class="traffic">
      <button type="button" class="tl tl-close" data-win="close" title="Fermer" aria-label="Fermer la fenêtre">${icon('x')}</button>
      <button type="button" class="tl tl-min" data-win="min" title="Réduire" aria-label="Réduire la fenêtre">${icon('minus')}</button>
      <button type="button" class="tl tl-max" data-win="max" title="Agrandir" aria-label="Agrandir la fenêtre">${icon('maximize')}</button>
    </div>
    <div class="window-title" id="window-title"></div>
    <div class="window-bar-end"></div>`;
}

export function mountDesktop(options) {
  hooks = { ...hooks, ...options };
  windows = store.get(windowsKey(), []);
  $('.shell').classList.toggle('win-max', Boolean(store.get(MAX_KEY, false)));
  drawMaxButton();
  drawUserButton();
  drawThemeButton();
  tickClock();
  refreshNotifications();
  $('#side-toggle').addEventListener('click', () => hooks.onToggleSidebar());
  $('#mb-search').addEventListener('click', openSearch);
  $('#theme-toggle').addEventListener('click', toggleTheme);
  $('#mb-notif').addEventListener('click', (e) => togglePopover('notif', e.currentTarget));
  $('#mb-user').addEventListener('click', (e) => togglePopover('user', e.currentTarget));
  $('#mb-popover').addEventListener('click', (e) => {
    const item = e.target.closest('[data-menu], a');
    if (!item) return;
    if (item.dataset.menu === 'theme') toggleTheme();
    if (item.dataset.menu === 'logout') hooks.onLogout();
    closePopover();
  });
  $('#window-bar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-win]');
    if (b) windowAction(b.dataset.win);
  });
  $('#window-bar').addEventListener('dblclick', (e) => {
    if (!e.target.closest('[data-win]')) windowAction('max');
  });
}

// Écouteurs globaux (une seule fois) : clic hors des menus, Échap, Ctrl+K, thème
let globalsReady = false;
export function initDesktopGlobals() {
  if (globalsReady) return;
  globalsReady = true;
  document.addEventListener('mousedown', (e) => {
    if (openPopover && !e.target.closest('#mb-popover, #mb-notif, #mb-user')) closePopover();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && state.user) {
      e.preventDefault();
      if (search) closeSearch();
      else openSearch();
    }
    if (e.key === 'Escape') {
      if (search) closeSearch();
      closePopover();
    }
  });
  window.addEventListener('astra:theme', drawThemeButton);
  window.addEventListener('hashchange', closePopover);
}

export function refreshDesktop() {
  drawWindows();
  refreshNotifications();
  if (current) {
    const app = current.key.startsWith('app:') ? state.apps.find((a) => `app:${a.id}` === current.key) : null;
    if (app && app.name !== current.title) {
      current.title = app.name;
      drawTitle();
    }
  }
}

// Bouton du panneau latéral : masquer / afficher sur grand écran, menu sur téléphone
export function sidebarIcon(hidden) {
  const button = $('#side-toggle');
  if (!button) return;
  const wide = window.matchMedia('(min-width: 901px)').matches;
  setHTML(button, icon(!wide ? 'menu' : hidden ? 'panelOpen' : 'panelClose'));
  button.title = !wide ? 'Menu' : hidden ? 'Afficher le panneau latéral' : 'Masquer le panneau latéral';
}

export function stopDesktop() {
  clearTimeout(clockTimer);
  closeSearch();
  closePopover();
  current = null;
}

// Environnement de bureau façon système d'exploitation :
// - barre du haut : panneau latéral, logo, recherche au centre (Ctrl+K), notifications, thème, horloge, compte ;
// - chaque page s'affiche en plein écran dans une fenêtre posée sur le fond d'écran (le contenu défile dans la fenêtre) ;
// - le tableau de bord est le « bureau » : ses widgets sont posés directement sur le fond d'écran.
import { api } from './api.js';
import { isAdmin, refreshApps, state } from './state.js';
import { THEMES, applyAppearance, effectiveTheme } from './theme.js';
import { $, ROLE_LABEL, TYPE_INFO, avatar, copyText, html, icon, localUrl, openContextMenu, setHTML, statusOf, toast } from './ui.js';

const APP_TABS = {
  console: 'Console',
  stats: 'Statistiques',
  files: 'Fichiers',
  env: 'Variables',
  deploy: 'Déploiement',
  settings: 'Paramètres',
  users: 'Utilisateurs',
};
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

const sys = { update: null, tunnel: null, system: null };
let hooks = { onLogout: () => {}, onToggleSidebar: () => {} };
let current = null; // page affichée dans la fenêtre : { key, title, icon, tone }
let openPopover = null;

// ---- Fenêtre de la page affichée -----------------------------------------------------------------
// Décrit la fenêtre d'une page d'après son itinéraire (titre, icône, couleur de la tuile).
function describe(nav, params) {
  const [a] = params;
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
  current = info;
  const title = () => {
    const sub = info && describe(nav, params)?.sub;
    document.title = info ? `${info.title}${sub ? ` · ${sub}` : ''} — AstraPanel` : 'AstraPanel';
  };
  title();
  // l'onglet retenu d'une application n'est connu qu'après l'affichage de la page
  setTimeout(title, 0);
}

// ---- Notifications --------------------------------------------------------------------------------
// Chaque notification a une clé : une fois effacée (croix ou « Tout effacer »), elle ne revient que si la situation
// disparaît puis se reproduit (application de nouveau plantée, nouvelle version, nouvelle sous-tension…).
// Les effacements sont retenus par compte, dans ce navigateur.
const dismissedKey = () => `astra.notif.dismissed.${state.user?.id || ''}`;
let dismissed = null;
function loadDismissed() {
  try {
    dismissed = new Set(JSON.parse(localStorage.getItem(dismissedKey()) || '[]'));
  } catch {
    dismissed = new Set();
  }
}
function saveDismissed() {
  try {
    localStorage.setItem(dismissedKey(), JSON.stringify([...dismissed].slice(-300)));
  } catch {
    // stockage indisponible : l'effacement vaut jusqu'au rechargement de la page
  }
}

// source de chaque type de notification : on n'oublie un effacement que si cette source est connue
const SOURCE = { crash: 'apps', busy: 'apps', deploy: 'apps', update: 'update', tunnel: 'tunnel', power: 'system', heat: 'system' };

function allNotifications() {
  const out = [];
  for (const app of state.apps) {
    if (app.runtime.status === 'crashed') {
      // chaque plantage a sa propre clé : un nouveau plantage notifie de nouveau, même s'il suit de près
      out.push({ key: `crash:${app.id}:${app.runtime.lastExit?.at || ''}`, level: 'err', icon: 'alert', title: `${app.name} est planté`, text: 'Voir la console', href: `#/apps/${app.id}/console` });
    }
    if (app.runtime.busy) {
      out.push({ key: `busy:${app.id}`, level: 'info', icon: 'refresh', title: `${app.name} : ${statusOf(app).label}`, text: 'Suivre dans la console', href: `#/apps/${app.id}/console` });
    }
    const hook = app.webhookLog?.[0];
    if (hook?.outcome === 'failed' && Date.now() - (hook.doneAt || hook.at) < 24 * 3600_000) {
      out.push({ key: `deploy:${app.id}:${hook.at}`, level: 'err', icon: 'upload', title: `Échec du déploiement de ${app.name}`, text: hook.error || 'Voir l’onglet Déploiement', href: `#/apps/${app.id}/deploy` });
    }
  }
  if (isAdmin() && sys.update?.available) {
    out.push({ key: `update:${sys.update.latestVersion}`, level: 'ok', icon: 'arrowUpCircle', title: `AstraPanel ${sys.update.latestVersion} est disponible`, text: `Vous utilisez la version ${sys.update.installed?.version || '?'} : mettre à jour`, href: '#/settings/mises-a-jour' });
  }
  const t = sys.tunnel;
  if (isAdmin() && t?.enabled && (t.binary || t.running) && !(t.running && (t.ready?.readyConnections || 0) > 0)) {
    out.push({ key: 'tunnel:down', level: 'warn', icon: 'cloud', title: 'Tunnel Cloudflare déconnecté', text: 'Vos sites ne sont plus joignables depuis Internet', href: '#/settings/tunnel' });
  }
  // alimentation et chaleur (cartes qui les signalent) : pour tous les comptes
  const th = sys.system?.throttling;
  if (th) {
    const boot = sys.system.bootedAt;
    if (th.underVoltage) {
      out.push({ key: `power:now:${boot}`, level: 'err', icon: 'zap', title: 'Sous-tension détectée', text: 'L’alimentation de la machine est insuffisante : elle ralentit et peut planter. Utilisez l’alimentation recommandée par le fabricant.', href: isAdmin() ? '#/settings/hardware' : '#/' });
    } else if (th.underVoltageOccurred) {
      out.push({ key: `power:boot:${boot}`, level: 'warn', icon: 'zap', title: 'Une sous-tension a eu lieu depuis le démarrage', text: 'Vérifiez l’alimentation et son câble.', href: isAdmin() ? '#/settings/hardware' : '#/' });
    }
    if (th.throttled || th.softTempLimit) {
      out.push({ key: `heat:${boot}`, level: 'warn', icon: 'thermo', title: 'Processeur bridé à cause de la chaleur', text: 'Améliorez le refroidissement de la machine (ventilateur, dissipateur, aération).', href: isAdmin() ? '#/settings/hardware' : '#/' });
    }
  }
  return out;
}

// retire d'un ensemble de clés celles dont la situation a disparu (seulement si leur source est déjà chargée)
function forgetGone(keys, present) {
  const known = new Set([...(state.appsLoaded ? ['apps'] : []), ...Object.keys(sys).filter((k) => sys[k])]);
  let changed = false;
  for (const key of keys) {
    const source = SOURCE[key.split(':')[0]];
    if (source && known.has(source) && !present.has(key)) {
      keys.delete(key);
      changed = true;
    }
  }
  return changed;
}

function notifications() {
  if (!dismissed) loadDismissed();
  if (!seen) loadSeen();
  const all = allNotifications();
  // effacements et annonces devenus inutiles (la situation a disparu) : oubliés, pour être prévenu si elle revient
  const present = new Set(all.map((n) => n.key));
  if (forgetGone(dismissed, present)) saveDismissed();
  if (forgetGone(seen, present)) saveSeen();
  return all.filter((n) => !dismissed.has(n.key));
}

function dismiss(keys) {
  if (!dismissed) loadDismissed();
  for (const key of keys) dismissed.add(key);
  saveDismissed();
  refreshNotifications();
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
  announce(list);
}

// ---- Bannières : une notification qui arrive s'affiche quelques secondes sous la cloche ------------
// Chaque notification n'est annoncée qu'une fois (clés retenues par compte, dans ce navigateur) ; si l'onglet est
// en arrière-plan, l'annonce attend que l'on revienne dessus.
const BANNER_MS = 4500;
const MAX_BANNERS = 3;
const seenKey = () => `astra.notif.seen.${state.user?.id || ''}`;
let seen = null;
function loadSeen() {
  try {
    seen = new Set(JSON.parse(localStorage.getItem(seenKey()) || '[]'));
  } catch {
    seen = new Set();
  }
}
function saveSeen() {
  try {
    localStorage.setItem(seenKey(), JSON.stringify([...seen].slice(-300)));
  } catch {
    // stockage indisponible : les annonces valent jusqu'au rechargement de la page
  }
}

function announce(list) {
  if (!seen) loadSeen();
  const fresh = list.filter((n) => !seen.has(n.key));
  if (!fresh.length || document.hidden || !$('#mb-banners')) return;
  for (const n of fresh) seen.add(n.key);
  saveSeen();
  ringBell();
  if (openPopover !== 'notif') showBanners(fresh); // liste ouverte : elle est déjà sous les yeux
}

function ringBell() {
  const bell = $('#mb-notif');
  if (!bell) return;
  bell.classList.remove('ring');
  void bell.offsetWidth; // relance l'animation
  bell.classList.add('ring');
}

function showBanners(fresh) {
  const box = $('#mb-banners');
  const bell = $('#mb-notif');
  if (!box || !bell) return;
  const r = bell.getBoundingClientRect();
  box.style.right = `${Math.max(8, window.innerWidth - r.right - 4)}px`;
  // trop d'arrivées d'un coup : les premières, puis un résumé qui ouvre la liste
  const shown = fresh.length > MAX_BANNERS ? fresh.slice(0, MAX_BANNERS - 1) : fresh;
  const rest = fresh.length - shown.length;
  const items = shown.map(
    (n) => html`<a class="notif ${n.level}" href="${n.href}">
      <span class="notif-icon">${icon(n.icon)}</span>
      <span class="notif-text"><b>${n.title}</b><span>${n.text}</span></span>
    </a>`,
  );
  if (rest) {
    items.push(html`<a class="notif" href="#" data-banner-list>
      <span class="notif-icon">${icon('bell')}</span>
      <span class="notif-text"><b>${rest} autre${rest > 1 ? 's' : ''} notification${rest > 1 ? 's' : ''}</b><span>Ouvrir la liste</span></span>
    </a>`);
  }
  // la plus récente en haut, juste sous la cloche
  for (const item of items.reverse()) addBanner(box, item);
  while (box.children.length > MAX_BANNERS) box.lastElementChild.remove();
}

function addBanner(box, content) {
  const el = document.createElement('div');
  el.className = 'mb-banner';
  el.style.setProperty('--banner-ms', `${BANNER_MS}ms`);
  setHTML(el, html`${content}<button type="button" class="notif-dismiss" data-banner-close title="Masquer" aria-label="Masquer">${icon('x')}</button><i class="mb-banner-time"></i>`);
  box.prepend(el);
  // compte à rebours mis en pause tant que la souris est dessus (comme la barre de temps)
  let left = BANNER_MS;
  let started = Date.now();
  let timer = setTimeout(() => hideBanner(el), left);
  el.addEventListener('mouseenter', () => {
    clearTimeout(timer);
    left = Math.max(800, left - (Date.now() - started));
  });
  el.addEventListener('mouseleave', () => {
    started = Date.now();
    timer = setTimeout(() => hideBanner(el), left);
  });
}

function hideBanner(el) {
  if (!el.isConnected || el.classList.contains('leaving')) return;
  el.classList.add('leaving');
  setTimeout(() => el.remove(), 220);
}

function hideAllBanners() {
  document.querySelectorAll('.mb-banner').forEach(hideBanner);
}

function drawNotifications() {
  const list = notifications();
  setHTML(
    $('#mb-popover'),
    html`<div class="popover-head">
        <b>Notifications</b>
        ${list.length ? html`<button type="button" class="btn btn-ghost btn-sm notif-clear" data-notif-clear>${icon('trash')} Tout effacer</button>` : ''}
      </div>
      ${list.length
        ? html`<ul class="notif-list">
            ${list.map(
              (n) => html`<li class="notif-item">
                <a class="notif ${n.level}" href="${n.href}">
                  <span class="notif-icon">${icon(n.icon)}</span>
                  <span class="notif-text"><b>${n.title}</b><span>${n.text}</span></span>
                </a>
                <button type="button" class="notif-dismiss" data-notif-dismiss="${n.key}" title="Effacer" aria-label="Effacer la notification « ${n.title} »">${icon('x')}</button>
              </li>`,
            )}
          </ul>`
        : html`<div class="popover-empty">${icon('check')} Aucune notification</div>`}`,
  );
}

export function setSystemInfo(info) {
  Object.assign(sys, info);
  refreshNotifications();
}

// ---- Menu du compte -------------------------------------------------------------------------------
function drawUserMenu() {
  const u = state.user;
  setHTML(
    $('#mb-popover'),
    html`<div class="popover-user">
        ${avatar(u, 'lg')}
        <div class="truncate"><b class="truncate">${u.username}</b><span class="faint">${ROLE_LABEL[u.role]}</span></div>
      </div>
      <div class="popover-menu">
        <a href="#/settings/compte">${icon('user')} Mon compte</a>
        <div class="popover-theme segmented" role="group" aria-label="Thème">
          ${THEMES.map((t) => html`<button type="button" data-menu-theme="${t.id}" aria-pressed="${t.id === (state.user.prefs?.theme || 'auto')}" title="${t.label}">${icon(t.icon)}<span>${t.label}</span></button>`)}
        </div>
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
  if (kind === 'notif') {
    hideAllBanners();
    drawNotifications();
  }
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
  state.user = { ...state.user, prefs: { ...state.user.prefs, theme: next } };
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
  return html`<div class="mb-left">
      <button class="mb-btn" id="side-toggle" title="Panneau latéral" aria-label="Afficher ou masquer le panneau latéral">${icon('panelClose')}</button>
      <a class="mb-brand" href="#/" title="Tableau de bord">${icon('logo')}<span>Astra<b>Panel</b></span></a>
    </div>
    <button class="mb-btn mb-search" id="mb-search" title="Rechercher (Ctrl+K)" aria-label="Rechercher">${icon('search')}<span>Rechercher une application, une page…</span><kbd>Ctrl K</kbd></button>
    <div class="mb-right">
      <button class="mb-btn" id="mb-notif" title="Notifications" aria-label="Notifications" aria-expanded="false">${icon('bell')}<span class="mb-badge" id="mb-notif-count" hidden></span></button>
      <button class="mb-btn" id="theme-toggle"></button>
      <div class="mb-clock" aria-hidden="true"><span id="mb-date"></span><b id="mb-time"></b></div>
      <button class="mb-user" id="mb-user" title="Mon compte" aria-label="Menu du compte" aria-expanded="false"></button>
    </div>
    <div class="mb-popover" id="mb-popover" hidden></div>
    <div class="mb-banners" id="mb-banners" role="status" aria-live="polite"></div>`;
}

export function mountDesktop(options) {
  hooks = { ...hooks, ...options };
  loadDismissed();
  loadSeen();
  drawUserButton();
  drawThemeButton();
  tickClock();
  refreshNotifications();
  $('#side-toggle').addEventListener('click', () => hooks.onToggleSidebar());
  $('#mb-search').addEventListener('click', openSearch);
  $('#theme-toggle').addEventListener('click', toggleTheme);
  $('#mb-notif').addEventListener('click', (e) => togglePopover('notif', e.currentTarget));
  $('#mb-user').addEventListener('click', (e) => togglePopover('user', e.currentTarget));
  $('#mb-notif').addEventListener('animationend', (e) => e.currentTarget.classList.remove('ring'));
  $('#mb-banners').addEventListener('click', (e) => {
    const banner = e.target.closest('.mb-banner');
    if (!banner) return;
    if (e.target.closest('[data-banner-close]')) {
      hideBanner(banner);
      return;
    }
    if (e.target.closest('[data-banner-list]')) {
      e.preventDefault();
      togglePopover('notif', $('#mb-notif'));
      return;
    }
    if (e.target.closest('a')) hideBanner(banner);
  });
  $('#mb-popover').addEventListener('click', async (e) => {
    const one = e.target.closest('[data-notif-dismiss]');
    if (one) {
      e.preventDefault();
      dismiss([one.dataset.notifDismiss]);
      return;
    }
    if (e.target.closest('[data-notif-clear]')) {
      dismiss(notifications().map((n) => n.key));
      return;
    }
    // thème choisi dans le menu du compte : appliqué tout de suite, le menu reste ouvert
    const theme = e.target.closest('[data-menu-theme]');
    if (theme) {
      const next = theme.dataset.menuTheme;
      applyAppearance({ ...state.user.prefs, theme: next });
      state.user = { ...state.user, prefs: { ...state.user.prefs, theme: next } };
      drawUserMenu();
      try {
        const { user } = await api.patch('/account/preferences', { theme: next });
        state.user = { ...state.user, ...user };
      } catch {
        // le choix reste appliqué sur cet appareil
      }
      return;
    }
    const item = e.target.closest('[data-menu], a');
    if (!item) return;
    if (item.dataset.menu === 'theme') toggleTheme();
    if (item.dataset.menu === 'logout') hooks.onLogout();
    closePopover();
  });
}

// ---- Menu clic droit du site ------------------------------------------------------------------------
// (le gestionnaire de fichiers a le sien ; Maj + clic droit et les champs de saisie gardent celui du navigateur)
function appMenu(app) {
  const running = app.runtime.status === 'running' || app.runtime.status === 'restarting';
  const act = (action, label) => async () => {
    await api.post(`/apps/${app.id}/${action}`);
    toast(`${app.name} : ${label}`);
    await refreshApps();
  };
  const url = localUrl(app);
  return [
    { label: 'Ouvrir', icon: 'external', onClick: () => (location.hash = `#/apps/${app.id}`) },
    { label: 'Console', icon: 'terminal', onClick: () => (location.hash = `#/apps/${app.id}/console`) },
    { label: 'Statistiques', icon: 'activity', onClick: () => (location.hash = `#/apps/${app.id}/stats`) },
    { label: 'Fichiers', icon: 'folder', onClick: () => (location.hash = `#/apps/${app.id}/files`) },
    { label: 'Paramètres', icon: 'sliders', onClick: () => (location.hash = `#/apps/${app.id}/settings`) },
    '-',
    running
      ? { label: 'Arrêter', icon: 'stop', disabled: Boolean(app.runtime.busy), onClick: act('stop', 'arrêt demandé') }
      : { label: 'Démarrer', icon: 'play', disabled: Boolean(app.runtime.busy), onClick: act('start', 'démarrage') },
    { label: 'Redémarrer', icon: 'restart', disabled: Boolean(app.runtime.busy), onClick: act('restart', 'redémarrage') },
    '-',
    ...(app.domains || []).slice(0, 2).map((d) => ({ label: `Ouvrir ${d}`, icon: 'globe', onClick: () => window.open(`https://${d}`, '_blank', 'noopener') })),
    url && { label: 'Ouvrir le site (réseau local)', icon: 'external', onClick: () => window.open(url, '_blank', 'noopener') },
  ];
}

function contextItems(target, x, y) {
  const items = [];
  const selection = String(window.getSelection?.() || '').trim();
  if (selection) items.push({ label: 'Copier', icon: 'copy', hint: 'Ctrl+C', onClick: () => copyText(selection) }, '-');
  const link = target.closest('a[href]');
  const appLink = link && /^#\/apps\/([^/]+)/.exec(link.getAttribute('href') || '');
  const app = appLink && state.apps.find((a) => a.id === appLink[1]);
  if (app && link.closest('.side-app, .app-tile, .spotlight-item')) return [...items, ...appMenu(app)];
  if (link && /^https?:/.test(link.getAttribute('href'))) {
    items.push(
      { label: 'Ouvrir le lien dans un nouvel onglet', icon: 'external', onClick: () => window.open(link.href, '_blank', 'noopener') },
      { label: 'Copier l’adresse du lien', icon: 'link', onClick: async () => { await copyText(link.href); toast('Adresse copiée'); } },
      '-',
    );
  }
  const hidden = $('.shell')?.classList.contains('side-hidden');
  const dark = effectiveTheme() === 'dark';
  items.push(
    { label: 'Rechercher…', icon: 'search', hint: 'Ctrl+K', onClick: openSearch },
    { label: 'Nouvelle application', icon: 'plus', onClick: () => (location.hash = '#/new') },
    { label: 'Actualiser', icon: 'refresh', onClick: () => window.dispatchEvent(new HashChangeEvent('hashchange')) },
    '-',
    { label: dark ? 'Thème clair' : 'Thème sombre', icon: dark ? 'sun' : 'moon', onClick: toggleTheme },
    window.matchMedia('(min-width: 901px)').matches && { label: hidden ? 'Afficher le panneau latéral' : 'Masquer le panneau latéral', icon: hidden ? 'panelOpen' : 'panelClose', onClick: () => hooks.onToggleSidebar() },
    '-',
    { label: 'Tableau de bord', icon: 'grid', onClick: () => (location.hash = '#/') },
    { label: 'Paramètres', icon: 'sliders', onClick: () => (location.hash = '#/settings') },
    { label: 'Aide', icon: 'book', onClick: () => (location.hash = '#/aide') },
  );
  return items;
}

// Écouteurs globaux (une seule fois) : clic hors des menus, Échap, Ctrl+K, thème, clic droit
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
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.user) refreshNotifications();
  });
  document.addEventListener('contextmenu', (e) => {
    if (!state.user || e.defaultPrevented || e.shiftKey) return;
    if (e.target.closest('input, textarea, select, [contenteditable], .editor, .ctx-menu')) return;
    e.preventDefault();
    closePopover();
    openContextMenu(e.clientX, e.clientY, contextItems(e.target, e.clientX, e.clientY));
  });
}

export function refreshDesktop() {
  refreshNotifications();
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

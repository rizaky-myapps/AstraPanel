import { api, qs, upload } from '../api.js';
import { findApp, isAdmin, onAppsChange, refreshApps, state } from '../state.js';
import { envEditor } from '../env-editor.js';
import { filesTab } from './files.js';
import { renderLineChart } from '../chart.js';
import { newState, renderAnsi } from '../ansi.js';
import {
  $,
  avatar,
  pageHero,
  TYPE_INFO,
  confirmDialog,
  copyText,
  domainUrl,
  filePicker,
  formatBytes,
  formatDate,
  formatDuration,
  formatPercent,
  formatLogTime,
  html,
  icon,
  localUrl,
  modal,
  routingWarnings,
  setHTML,
  statusBadge,
  statusOf,
  tip,
  toast,
  toggle,
  withBusy,
} from '../ui.js';

const TABS = [
  { id: 'console', label: 'Console', icon: 'terminal' },
  { id: 'stats', label: 'Statistiques', icon: 'activity' },
  { id: 'files', label: 'Fichiers', icon: 'folder' },
  { id: 'env', label: 'Variables', icon: 'key' },
  { id: 'deploy', label: 'Déploiement', icon: 'upload' },
  { id: 'settings', label: 'Paramètres', icon: 'sliders' },
  { id: 'users', label: 'Utilisateurs', icon: 'users' },
];

// Dernier onglet ouvert : on le garde en passant d'une application à l'autre (barre latérale, journal…).
const TAB_KEY = 'astra.app-tab';
let lastTab = null;
try {
  lastTab = localStorage.getItem(TAB_KEY);
} catch {
  // stockage indisponible : on retient l'onglet le temps de la session
}
const isTab = (tab) => TABS.some((t) => t.id === tab);

export function renderApp(view, page, id, tab) {
  // lien sans onglet (#/apps/<id>) : on ouvre l'onglet utilisé en dernier, et l'adresse l'indique
  if (!tab) {
    tab = isTab(lastTab) ? lastTab : 'console';
    history.replaceState(null, '', `#/apps/${id}/${tab}`);
  }
  if (!isTab(tab)) tab = 'console';
  lastTab = tab;
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    // stockage indisponible
  }
  const app = findApp(id);
  if (!app) {
    setHTML(
      view,
      html`<div class="card empty"><h2>Application introuvable</h2><p>Elle a peut-être été supprimée.</p><a class="btn" href="#/">Retour au tableau de bord</a></div>`,
    );
    return;
  }

  const root = document.createElement('div');
  view.replaceChildren(root);
  setHTML(
    root,
    html`<a class="back" href="#/">${icon('back')} Tableau de bord</a>
      <div id="app-header"></div>
      <div id="app-busy"></div>
      <nav class="tabs">
        ${TABS.map((t) => html`<a href="#/apps/${id}/${t.id}" class="${t.id === tab ? 'active' : ''}">${icon(t.icon)} ${t.label}</a>`)}
      </nav>
      <div id="tab"></div>`,
  );

  const header = $('#app-header', root);
  const busyBox = $('#app-busy', root);
  const update = () => {
    const current = findApp(id);
    if (!current) {
      location.hash = '#/';
      return;
    }
    renderHeader(header, current);
    renderBusy(busyBox, current);
  };
  update();
  page.onCleanup(onAppsChange(update));

  header.addEventListener('click', (e) => {
    const button = e.target.closest('[data-action]');
    if (!button) return;
    const { action } = button.dataset;
    withBusy(button, async () => {
      if (action === 'kill' && !(await confirmDialog('Forcer l’arrêt ?', 'Le processus sera tué immédiatement (SIGKILL), sans lui laisser le temps de s’arrêter proprement.', { danger: true, confirmLabel: 'Forcer l’arrêt' }))) return;
      await api.post(`/apps/${id}/${action}`);
      await refreshApps();
    });
  });
  busyBox.addEventListener('click', (e) => {
    const button = e.target.closest('[data-cancel]');
    if (button) withBusy(button, () => api.post(`/apps/${id}/tasks/cancel`));
  });

  const renderers = { console: consoleTab, stats: statsTab, files: filesTab, env: envTab, deploy: deployTab, settings: settingsTab, users: usersTab };
  renderers[tab]($('#tab', root), page, app);
}

function renderHeader(el, app) {
  const type = TYPE_INFO[app.type];
  const rt = app.runtime;
  const running = rt.status === 'running';
  const active = running || rt.status === 'restarting' || rt.status === 'stopping';
  const busy = Boolean(rt.busy);
  // indicateurs façon barre d'état, comme sur le tableau de bord
  const pills = [html`<span class="desk-pill">${icon(type.icon)} ${type.label}</span>`];
  if (app.port) pills.push(html`<span class="desk-pill">${icon('link')} port ${app.port}</span>`);
  if (running) {
    pills.push(html`<span class="desk-pill">${icon('clock')} depuis ${formatDuration(Date.now() - rt.startedAt)}</span>`);
    pills.push(html`<span class="desk-pill">${icon('cpu')} CPU ${formatPercent(rt.cpu)}</span>`);
    pills.push(html`<span class="desk-pill">${icon('memory')} RAM ${formatBytes(rt.memory)}</span>`);
    pills.push(html`<span class="desk-pill faint-pill">PID ${rt.pid}</span>`);
  } else if (rt.lastExit) {
    pills.push(html`<span class="desk-pill">${icon('clock')} dernier arrêt ${formatDate(rt.lastExit.at)}</span>`);
  }
  const url = localUrl(app);

  setHTML(
    el,
    pageHero({
      icon: type.icon,
      tone: app.type,
      title: app.name,
      badge: statusBadge(app),
      meta: pills,
      cls: 'app-hero',
      actions: html`${app.domains.length || url
          ? html`<div class="row app-links">
              ${app.domains.map((d) => html`<a class="btn btn-glass btn-sm" href="${domainUrl(d)}" target="_blank" rel="noopener">${icon('globe')} ${d}</a>`)}
              ${url ? html`<a class="btn btn-glass btn-sm" href="${url}" target="_blank" rel="noopener">${icon('external')} Ouvrir</a>` : ''}
            </div>`
          : ''}
        <div class="row app-controls">
          ${active
            ? html`<button class="btn btn-glass" data-action="stop" ${busy ? 'disabled' : ''}>${icon('stop')} Arrêter</button>`
            : html`<button class="btn btn-success" data-action="start" ${busy ? 'disabled' : ''}>${icon('play')} Démarrer</button>`}
          <button class="btn btn-glass" data-action="restart" ${busy ? 'disabled' : ''}>${icon('restart')} Redémarrer</button>
          ${active ? html`<button class="btn btn-glass btn-icon" data-action="kill" title="Forcer l'arrêt" aria-label="Forcer l'arrêt">${icon('zap')}</button>` : ''}
        </div>`,
    }),
  );
}

function renderBusy(el, app) {
  const busy = app.runtime.busy;
  if (!busy) {
    el.textContent = '';
    return;
  }
  const labels = { deploy: 'Déploiement en cours', install: 'Installation des dépendances', build: 'Build en cours', archive: 'Import de l’archive' };
  setHTML(
    el,
    html`<div class="alert busy">
      <div class="spinner sm"></div>
      <div>${labels[busy] || 'Tâche en cours'}… suivez la progression dans la console.</div>
      <span class="spacer"></span>
      ${busy !== 'archive' ? html`<button class="btn btn-sm btn-ghost" data-cancel>${icon('x')} Annuler</button>` : ''}
    </div>`,
  );
}

// ---- Console ----------------------------------------------------------------
function consoleTab(el, page, app) {
  setHTML(
    el,
    html`<div class="console">
      <div class="console-toolbar">
        <span class="badge plain" id="live">Connexion…</span>
        <span class="spacer"></span>
        <label class="check inline">${toggle('autoscroll', true, { id: 'autoscroll', sm: true })}<span class="hint">Défilement auto</span></label>
        <a class="btn btn-ghost btn-sm" href="/api/apps/${app.id}/logs/download">${icon('download')} <span class="hide-sm">Télécharger</span></a>
        <button class="btn btn-ghost btn-sm" id="clear-logs">${icon('trash')} <span class="hide-sm">Effacer</span></button>
      </div>
      <div class="console-output" id="out"></div>
      <form class="console-input" id="stdin">
        <input type="text" placeholder="Envoyer une ligne sur l'entrée standard du processus…" autocomplete="off" spellcheck="false" />
        <button class="btn btn-sm" type="submit" title="Envoyer">${icon('send')}</button>
      </form>
    </div>`,
  );

  const out = $('#out', el);
  const live = $('#live', el);
  const autoscroll = $('#autoscroll', el);
  const MAX_NODES = 2000;

  // La console remplit exactement la fenêtre : rien d'autre ne défile (sauf sur un écran trop bas)
  const fit = () => {
    const body = document.getElementById('window-body');
    if (!body || !out.isConnected) return;
    const pad = parseFloat(getComputedStyle(body).paddingBottom) || 0;
    const below = out.parentElement.getBoundingClientRect().bottom - out.getBoundingClientRect().bottom;
    const room = body.getBoundingClientRect().bottom - pad - out.getBoundingClientRect().top - below + body.scrollTop;
    out.style.height = `${Math.max(240, Math.floor(room))}px`;
  };
  requestAnimationFrame(fit);
  window.addEventListener('resize', fit);
  page.onCleanup(() => window.removeEventListener('resize', fit));

  const showEmpty = () => {
    out.textContent = '';
    const div = document.createElement('div');
    div.className = 'console-empty';
    div.textContent = 'Aucune sortie pour le moment. Démarrez l’application pour voir ses logs ici.';
    out.appendChild(div);
  };

  // couleurs choisies par l'application : elles se poursuivent d'une ligne à l'autre (comme dans un terminal),
  // séparément pour la sortie normale et la sortie d'erreur ; un message du panel repart de zéro
  let colors = { out: newState(), err: newState() };
  const append = (lines) => {
    out.querySelector('.console-empty')?.remove();
    const frag = document.createDocumentFragment();
    for (const line of lines) {
      if (line.s === 'sys') colors = { out: newState(), err: newState() };
      const row = document.createElement('div');
      row.className = `l ${line.s}`;
      const ts = document.createElement('span');
      ts.className = 'ts';
      ts.textContent = line.t ? formatLogTime(line.t) : '';
      const msg = document.createElement('span');
      msg.className = 'm';
      renderAnsi(msg, line.m, colors[line.s] || newState());
      row.append(ts, msg);
      frag.appendChild(row);
    }
    out.appendChild(frag);
    while (out.childElementCount > MAX_NODES) out.firstElementChild.remove();
    if (autoscroll.checked) out.scrollTop = out.scrollHeight;
  };

  const source = new EventSource(`/api/apps/${app.id}/logs/stream`);
  page.onCleanup(() => source.close());
  source.addEventListener('backlog', (e) => {
    const lines = JSON.parse(e.data);
    out.textContent = '';
    colors = { out: newState(), err: newState() };
    if (lines.length) append(lines);
    else showEmpty();
  });
  source.addEventListener('clear', showEmpty);
  source.onmessage = (e) => append([JSON.parse(e.data)]);
  source.onopen = () => {
    live.className = 'badge st-running';
    live.textContent = 'En direct';
  };
  source.onerror = () => {
    live.className = 'badge st-restarting';
    live.textContent = 'Reconnexion…';
  };

  $('#clear-logs', el).addEventListener('click', (e) => withBusy(e.currentTarget, () => api.del(`/apps/${app.id}/logs`)));

  $('#stdin', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = e.target.querySelector('input');
    if (!input.value) return;
    await withBusy(e.target.querySelector('button'), async () => {
      await api.post(`/apps/${app.id}/stdin`, { text: input.value });
      input.value = '';
    });
  });
}

// ---- Variables -----------------------------------------------------------------
function envTab(el, page, app) {
  setHTML(
    el,
    html`<div class="card env-card">
      <div class="card-header"><h2>${icon('key')} Variables d'environnement ${tip(
        app.type === 'bot'
          ? html`Mettez ici le token de votre bot (<code>DISCORD_TOKEN</code>) plutôt que dans le code : il ne sera jamais publié sur Git. Votre code les lit avec <code>process.env.NOM</code>.`
          : html`<code>PORT</code> est fourni automatiquement (${app.port}) : votre serveur doit écouter dessus. Votre code lit les variables avec <code>process.env.NOM</code>.`,
      )}</h2><span class="spacer"></span><span id="env-mode"></span></div>
      <div class="card-body env-body">
        <div id="env-editor"></div>
      </div>
      <div class="card-foot">
        <button class="btn" data-save="0">${icon('save')} Enregistrer</button>
        <button class="btn btn-primary" data-save="1">${icon('restart')} Enregistrer et redémarrer</button>
      </div>
    </div>`,
  );
  // La carte remplit la fenêtre : c'est la liste des variables (ou la zone de texte) qui défile, pas la page
  const card = $('.env-card', el);
  const fit = () => {
    const body = document.getElementById('window-body');
    if (!body || !card.isConnected) return;
    const pad = parseFloat(getComputedStyle(body).paddingBottom) || 0;
    const room = body.getBoundingClientRect().bottom - pad - card.getBoundingClientRect().top + body.scrollTop;
    // sur téléphone, une hauteur minimale garde la zone de saisie utilisable
    card.style.height = `${Math.max(window.innerWidth < 600 ? 440 : 360, Math.floor(room))}px`;
  };
  requestAnimationFrame(fit);
  window.addEventListener('resize', fit);
  page.onCleanup(() => window.removeEventListener('resize', fit));
  const editor = envEditor($('#env-editor', el), app.env, { modeSlot: $('#env-mode', el) });
  el.addEventListener('click', (e) => {
    const button = e.target.closest('[data-save]');
    if (!button) return;
    withBusy(button, async () => {
      await api.patch(`/apps/${app.id}`, { env: editor.getValue() });
      if (button.dataset.save === '1') await api.post(`/apps/${app.id}/restart`);
      toast(button.dataset.save === '1' ? 'Variables enregistrées, application redémarrée' : 'Variables enregistrées (redémarrez pour les appliquer)');
      await refreshApps();
    });
  });
}

// ---- Statistiques : historique processeur / mémoire de l'application ----------------------
const STAT_RANGES = [
  { id: '1h', label: '1 h', refresh: 10_000 },
  { id: '12h', label: '12 h', refresh: 60_000 },
  { id: '24h', label: '24 h', refresh: 60_000 },
  { id: '3j', label: '3 j', refresh: 120_000 },
  { id: '7j', label: '7 j', refresh: 120_000 },
];
const STAT_RANGE_KEY = 'astra.app-range';
const mo = (v, tick) => (v >= 1024 ? `${(v / 1024).toLocaleString('fr-FR', { maximumFractionDigits: tick ? 1 : 2 })} Go` : `${Math.round(v).toLocaleString('fr-FR')} Mo`);
const pct = (v, tick) => (tick ? `${v} %` : `${v.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`);
const niceMax = (v) => {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((f) => f * mag).find((c) => c >= v) || 10 * mag;
};
const APP_SERIES = [
  { id: 'cpu', title: 'Processeur', icon: 'cpu', index: 1, format: pct, domain: (values) => [0, Math.max(100, niceMax(Math.max(0, ...values) * 1.1))] },
  { id: 'mem', title: 'Mémoire vive', icon: 'memory', index: 2, format: mo, domain: (values) => [0, niceMax(Math.max(16, ...values) * 1.25)] },
];

function statsTab(el, page, app) {
  let range = null;
  try {
    range = localStorage.getItem(STAT_RANGE_KEY);
  } catch {
    range = null;
  }
  if (!STAT_RANGES.some((r) => r.id === range)) range = '1h';
  let data = null;

  setHTML(
    el,
    html`<div class="stack">
      <div class="grid stats app-stats" id="app-stat-tiles"></div>
      <div class="section-title">
        <h2>Historique ${tip('Charge du processeur et mémoire vive utilisées par l’application (tous ses processus, enfants compris), mesurées toutes les 10 secondes pendant qu’elle tourne. Un arrêt laisse un vide dans les courbes. Conservé 7 jours. 100 % = un cœur de processeur entièrement occupé.')}</h2>
        <div class="segmented" role="group" aria-label="Période affichée">
          ${STAT_RANGES.map((r) => html`<button type="button" data-range="${r.id}" aria-pressed="${r.id === range}">${r.label}</button>`)}
        </div>
      </div>
      <div class="grid charts app-charts" id="app-charts">
        ${APP_SERIES.map(
          (s) => html`<div class="card chart-card" data-series="${s.id}">
            <div class="chart-head"><h3>${icon(s.icon)} ${s.title}</h3><span class="chart-summary"></span></div>
            <div class="chart-body"></div>
          </div>`,
        )}
      </div>
    </div>`,
  );

  const charts = $('#app-charts', el);
  const seriesPoints = (s) => (data ? data.points.map((p) => [p[0], p[s.index]]) : []);

  // Cartes du haut : valeurs actuelles et pics de la période
  function drawTiles() {
    const current = findApp(app.id) || app;
    const rt = current.runtime;
    const running = rt.status === 'running';
    const values = (s) => seriesPoints(s).map((p) => p[1]).filter((v) => v !== null && v !== undefined);
    const cpuValues = values(APP_SERIES[0]);
    const memValues = values(APP_SERIES[1]);
    const label = STAT_RANGES.find((r) => r.id === range).label;
    const tile = (ic, title, value, detail) => html`<div class="card stat"><div class="label">${icon(ic)} ${title}</div><div class="value">${value}</div><div class="detail">${detail}</div></div>`;
    setHTML($('#app-stat-tiles', el), [
      tile('cpu', 'Processeur', running && rt.cpu !== null ? pct(rt.cpu) : '—', running ? 'en ce moment' : statusOf(current).label),
      tile('memory', 'Mémoire vive', running && rt.memory ? formatBytes(rt.memory) : '—', running ? 'en ce moment' : statusOf(current).label),
      tile('zap', `Pics sur ${label}`, cpuValues.length ? pct(Math.max(...cpuValues)) : '—', memValues.length ? `mémoire max ${mo(Math.max(...memValues))}` : 'pas encore de mesure'),
      tile('clock', running ? 'En ligne depuis' : 'Arrêtée', running && rt.startedAt ? formatDuration(Date.now() - rt.startedAt) : '—', `${rt.restarts || 0} redémarrage${rt.restarts > 1 ? 's' : ''} automatique${rt.restarts > 1 ? 's' : ''}`),
    ]);
  }

  function drawCharts() {
    if (!data || !page.active) return;
    charts.classList.remove('loading');
    const end = data.now;
    const start = end - data.span;
    for (const s of APP_SERIES) {
      const card = charts.querySelector(`[data-series="${s.id}"]`);
      const points = seriesPoints(s);
      const values = points.map((p) => p[1]).filter((v) => v !== null && v !== undefined);
      card.querySelector('.chart-summary').textContent = values.length
        ? `Actuel ${s.format(values.at(-1))} · moy. ${s.format(values.reduce((a, b) => a + b, 0) / values.length)} · max ${s.format(Math.max(...values))}`
        : '';
      renderLineChart(card.querySelector('.chart-body'), {
        points,
        start,
        end,
        step: data.step,
        domain: s.domain(values),
        format: s.format,
        label: `${s.title} de ${app.name} sur ${STAT_RANGES.find((r) => r.id === range).label}`,
      });
    }
    drawTiles();
  }

  let timer = null;
  async function load() {
    clearTimeout(timer);
    const asked = range;
    try {
      const result = await api.get(`/apps/${app.id}/metrics?range=${asked}`);
      if (!page.active || asked !== range) return;
      data = result;
      drawCharts();
    } catch {
      // nouvel essai au prochain rafraîchissement
    }
    if (page.active) timer = setTimeout(load, STAT_RANGES.find((r) => r.id === range).refresh);
  }

  el.querySelector('.segmented').addEventListener('click', (e) => {
    const button = e.target.closest('[data-range]');
    if (!button || button.dataset.range === range) return;
    range = button.dataset.range;
    try {
      localStorage.setItem(STAT_RANGE_KEY, range);
    } catch {
      // stockage indisponible
    }
    el.querySelectorAll('[data-range]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === range)));
    charts.classList.add('loading');
    load();
  });

  let resizeTimer = null;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawCharts, 150);
  };
  window.addEventListener('resize', onResize);
  page.onCleanup(onAppsChange(drawTiles));
  page.onCleanup(() => {
    clearTimeout(timer);
    window.removeEventListener('resize', onResize);
  });
  drawTiles();
  load();
}

// ---- Déploiement -------------------------------------------------------------
const HOOK_KINDS = {
  deploy: { label: 'Déploiement lancé', cls: 'st-busy' },
  queued: { label: 'En attente', cls: 'st-busy' },
  ping: { label: 'Adresse testée', cls: 'st-running' },
  ignored: { label: 'Ignoré', cls: '' },
  error: { label: 'Erreur', cls: 'st-crashed' },
};
// résultat du déploiement, ajouté une fois terminé
const HOOK_OUTCOMES = {
  ok: { label: 'Déployé', cls: 'st-running' },
  failed: { label: 'Échec du déploiement', cls: 'st-crashed' },
  merged: { label: 'Regroupé', cls: '' },
};

// Derniers appels du webhook : on voit si GitHub joint le panel, et pourquoi un push n'a pas été déployé.
function hookHistory(app) {
  const list = app.webhookLog || [];
  const rejectedAt = app.runtime?.webhookRejectedAt;
  return html`${rejectedAt && (!list[0] || rejectedAt > list[0].at)
      ? html`<div class="alert warn">${icon('alert')}<div><b>Appel refusé le ${formatDate(rejectedAt)}</b> : l'adresse utilisée n'est pas la bonne
          (ancienne adresse ou copie incomplète). Recopiez l'adresse ci-dessus dans le webhook.</div></div>`
      : ''}
    <div class="hook-log-head">Derniers appels reçus ${tip(
      html`Chaque appel du webhook est noté ici, avec la raison quand un push n'est pas déployé.<br /><br />
        Rien n'apparaît après un push ? L'appel n'atteint pas le panel : sur GitHub, ouvrez Settings → Webhooks → votre webhook →
        <b>Recent Deliveries</b> pour lire la réponse reçue (voir le tutoriel, étape 11).`,
    )}</div>
    ${list.length
      ? html`<ul class="hook-log">
          ${list.map((e) => {
            const kind = HOOK_OUTCOMES[e.outcome] || HOOK_KINDS[e.kind] || HOOK_KINDS.ignored;
            const detail = e.outcome === 'ok' || e.outcome === 'failed'
              ? e.detail.replace(/ : déploiement (lancé|en attente de la tâche en cours)$/, '')
              : e.outcome === 'merged'
                ? e.detail.replace(/ : déploiement en attente de la tâche en cours$/, ' : compris dans le déploiement suivant')
                : e.detail;
            return html`<li>
              <span class="badge ${kind.cls || 'plain'}">${kind.label}</span>
              <span class="hook-log-detail">${detail}${e.outcome === 'failed'
                ? html`<span class="hook-log-error">✖ ${e.error || 'erreur'} : détails dans la console</span>`
                : ''}</span>
              <span class="faint hook-log-date">${formatDate(e.at)}${e.provider ? ` · ${e.provider}` : ''}</span>
            </li>`;
          })}
        </ul>`
      : html`<p class="muted hook-log-empty">Aucun appel reçu pour l'instant.</p>`}`;
}

function deployTab(el, page, app) {
  const hookUrl = (token) => `${location.origin}/hooks/deploy/${app.id}/${token}`;
  setHTML(
    el,
    html`<div class="stack">
      <div class="card">
        <div class="card-header"><h2>${icon('upload')} Mettre à jour ${tip(
          html`Le déploiement ${app.git ? html`récupère la dernière version du dépôt Git, ` : ''}installe les dépendances
            (<code>${app.installCommand || 'désactivé'}</code>)${app.buildCommand ? html`, lance <code>${app.buildCommand}</code>` : ''}
            puis redémarre l'application si elle tournait.`,
        )}</h2></div>
        <div class="card-body">
          <div class="row">
            <button class="btn btn-primary" data-task="deploy">${icon('upload')} Déployer maintenant</button>
            <button class="btn" data-task="install">${icon('package')} Installer les dépendances</button>
            ${app.buildCommand ? html`<button class="btn" data-task="build">${icon('wrench')} Lancer le build</button>` : ''}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><h2>${icon('git')} Dépôt Git ${tip('Attention : un déploiement Git écrase les fichiers suivis par Git modifiés sur la machine (vos fichiers .env, node_modules… sont conservés).')}</h2></div>
        <form class="card-body form-grid" id="git-form">
          <div class="field">
            <label>URL du dépôt ${tip(html`Dépôt privé : <code>https://&lt;jeton&gt;@github.com/moi/projet.git</code> ou une clé SSH de déploiement.`)}</label>
            <input type="text" name="url" class="mono" value="${app.git?.url || ''}" placeholder="https://github.com/moi/projet.git" spellcheck="false" />
          </div>
          <div class="field">
            <label>Branche</label>
            <input type="text" name="branch" class="mono" value="${app.git?.branch || ''}" placeholder="par défaut" spellcheck="false" />
          </div>
          <div class="full row">
            <span class="spacer"></span>
            <button class="btn" type="submit">${icon('save')} Enregistrer</button>
          </div>
        </form>
      </div>

      <div class="card">
        <div class="card-header"><h2>${icon('archive')} Importer une archive ${tip('Le contenu (.zip, .tar.gz ou .tgz) est copié dans le dossier de l’application. Un ZIP téléchargé depuis GitHub fonctionne tel quel.')}</h2></div>
        <form class="card-body" id="archive-form">
          <div class="field">
            ${filePicker({ name: 'file', accept: '.zip,.tar,.tar.gz,.tgz', label: 'Choisir une archive…' })}
          </div>
          <label class="check">${toggle('clean')}<span>Vider le dossier avant l'import ${tip('Supprime tous les fichiers actuels, y compris .env et node_modules.')}</span></label>
          <label class="check">${toggle('deploy', true)}<span>Déployer ensuite ${tip('Installe les dépendances, lance le build puis redémarre l’application.')}</span></label>
          <div class="progress hidden"><i></i></div>
          <div class="row"><span class="spacer"></span><button class="btn" type="submit">${icon('upload')} Importer</button></div>
        </form>
      </div>

      ${app.git
        ? html`<div class="card">
            <div class="card-header"><h2>${icon('link')} Déploiement automatique (webhook) ${tip(
              html`À chaque <code>git push</code>, GitHub (ou GitLab, Gitea…) appelle cette adresse et le panel redéploie l'application.<br /><br />
                GitHub : dépôt → Settings → Webhooks → Add webhook. Payload URL = cette adresse, Content type = <code>application/json</code>,
                événement « Just the push event ». Le panel doit être joignable depuis Internet (tunnel Cloudflare).`,
            )}</h2></div>
            <div class="card-body">
              <div class="input-group">
                <input type="text" class="mono" readonly value="${hookUrl(app.webhookToken)}" id="hook-url" />
                <button class="btn" data-copy-hook>${icon('copy')} Copier</button>
                <button class="btn btn-ghost" data-regen-hook title="Générer une nouvelle adresse">${icon('refresh')}</button>
              </div>
              <div id="hook-history">${hookHistory(app)}</div>
            </div>
          </div>`
        : ''}
    </div>`,
  );

  // historique mis à jour en direct (la liste des applications est rafraîchie toutes les 3 s)
  const historyKey = (a) => `${(a?.webhookLog || []).map((e) => `${e.at}:${e.outcome || ''}`).join(',')}|${a?.runtime?.webhookRejectedAt || 0}`;
  let shownKey = historyKey(app);
  page.onCleanup(
    onAppsChange(() => {
      const current = findApp(app.id);
      const box = $('#hook-history', el);
      if (!current || !box || historyKey(current) === shownKey) return;
      shownKey = historyKey(current);
      setHTML(box, hookHistory(current));
    }),
  );

  el.addEventListener('click', (e) => {
    const task = e.target.closest('[data-task]');
    if (task) {
      withBusy(task, async () => {
        await api.post(`/apps/${app.id}/tasks/${task.dataset.task}`);
        await refreshApps();
        location.hash = `#/apps/${app.id}/console`;
      });
    }
    if (e.target.closest('[data-copy-hook]')) copyText($('#hook-url', el).value);
    const regen = e.target.closest('[data-regen-hook]');
    if (regen) {
      withBusy(regen, async () => {
        if (!(await confirmDialog('Nouvelle adresse ?', 'L’ancienne adresse du webhook ne fonctionnera plus.'))) return;
        const { webhookToken } = await api.post(`/apps/${app.id}/webhook`);
        $('#hook-url', el).value = hookUrl(webhookToken);
        await refreshApps();
      });
    }
  });

  $('#git-form', el).addEventListener('submit', (e) => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(e.target));
    withBusy($('[type=submit]', e.target), async () => {
      await api.patch(`/apps/${app.id}`, { git: values.url.trim() ? values : null });
      await refreshApps();
      toast('Dépôt Git enregistré');
      window.dispatchEvent(new HashChangeEvent('hashchange')); // ré-affiche l'onglet avec la nouvelle config
    });
  });

  $('#archive-form', el).addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    const file = form.file.files[0];
    if (!file) {
      toast('Choisissez une archive', 'err');
      return;
    }
    const progress = $('.progress', form);
    progress.classList.remove('hidden');
    withBusy($('[type=submit]', form), async () => {
      const params = { filename: file.name, clean: form.clean.checked ? '1' : '0', deploy: form.deploy.checked ? '1' : '0' };
      await upload(`/apps/${app.id}/archive?${qs(params)}`, file, (r) => {
        progress.firstElementChild.style.width = `${(r * 100).toFixed(0)}%`;
      });
      toast('Archive importée');
      await refreshApps();
      location.hash = `#/apps/${app.id}/console`;
    });
  });
}

// ---- Paramètres de l'app -------------------------------------------------------
function settingsTab(el, page, app) {
  const isStatic = app.type === 'static';
  const hasPort = app.type !== 'bot';
  setHTML(
    el,
    html`<div class="stack">
      <form class="card" id="settings-form">
        <div class="card-header"><h2>${icon('sliders')} Configuration ${tip(html`Les changements de commande ou de port s'appliquent au prochain redémarrage.<br />Dossier sur la machine : <code>${app.dir}</code>`)}</h2></div>
        <div class="card-body form-grid">
          <div class="field full"><label>Nom</label><input type="text" name="name" value="${app.name}" maxlength="60" /></div>
          ${isStatic
            ? ''
            : html`<div class="field full">
                <label>Commande de démarrage</label>
                <input type="text" name="startCommand" class="mono" value="${app.startCommand}" spellcheck="false" />
              </div>`}
          <div class="field">
            <label>Installation des dépendances</label>
            <input type="text" name="installCommand" class="mono" value="${app.installCommand}" spellcheck="false" />
          </div>
          <div class="field">
            <label>Commande de build</label>
            <input type="text" name="buildCommand" class="mono" value="${app.buildCommand}" placeholder="aucune" spellcheck="false" />
          </div>
          ${isStatic
            ? html`<div class="field">
                  <label>Dossier à servir</label>
                  <input type="text" name="staticDir" class="mono" value="${app.staticDir}" spellcheck="false" />
                </div>
                <div class="field">
                  <label>&nbsp;</label>
                  <label class="check">${toggle('spa', app.spa)}<span>Application monopage (SPA)</span></label>
                </div>`
            : ''}
          ${hasPort
            ? html`<div class="field">
                  <label>Port</label>
                  <input type="number" name="port" value="${app.port || ''}" min="1024" max="65535" />
                </div>
                <div class="field">
                  <label>Nom(s) de domaine ${tip('Publiés en HTTPS par le tunnel Cloudflare (Paramètres → Tunnel Cloudflare). Plusieurs domaines : séparez-les par des virgules.')}</label>
                  <input type="text" name="domains" class="mono" value="${app.domains.join(', ')}" placeholder="monsite.fr, www.monsite.fr" spellcheck="false" />
                </div>`
            : ''}
          <div class="full">
            <label class="check">${toggle('autoRestart', app.autoRestart)}<span>Redémarrage automatique en cas de plantage ${tip('Relance l’application si elle s’arrête de façon inattendue.')}</span></label>
            <label class="check">${toggle('startOnBoot', app.startOnBoot !== false)}<span>Démarrer avec la machine ${tip('Lance l’application à chaque démarrage de la machine. Désactivé : elle reste arrêtée jusqu’à ce que vous cliquiez sur « Démarrer ». Un simple redémarrage du panel (mise à jour) remet toujours l’application dans son état précédent.')}</span></label>
          </div>
        </div>
        <div class="card-foot">
          <button class="btn btn-primary" type="submit">${icon('save')} Enregistrer</button>
        </div>
      </form>

      ${isAdmin()
        ? html`<div class="card">
            <div class="card-header danger-head"><h2>${icon('alert')} Zone dangereuse</h2></div>
            <div class="card-body row">
              <div>
                <div class="label">Supprimer l'application ${tip('Arrête l’application et supprime définitivement ses fichiers et ses journaux.')}</div>
              </div>
              <span class="spacer"></span>
              <button class="btn btn-danger" data-delete>${icon('trash')} Supprimer</button>
            </div>
          </div>`
        : ''}
    </div>`,
  );

  $('#settings-form', el).addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    const values = Object.fromEntries(new FormData(form));
    const body = {
      name: values.name,
      installCommand: values.installCommand,
      buildCommand: values.buildCommand,
      autoRestart: form.autoRestart.checked,
      startOnBoot: form.startOnBoot.checked,
    };
    if (!isStatic) body.startCommand = values.startCommand;
    if (isStatic) Object.assign(body, { staticDir: values.staticDir, spa: form.spa.checked });
    if (hasPort) Object.assign(body, { port: values.port || null, domains: values.domains });
    withBusy($('[type=submit]', form), async () => {
      const result = await api.patch(`/apps/${app.id}`, body);
      if (routingWarnings(result)) toast('Paramètres enregistrés');
      await refreshApps();
    });
  });

  $('[data-delete]', el)?.addEventListener('click', async () => {
    const result = await modal({
      title: `Supprimer « ${app.name} » ?`,
      danger: true,
      confirmLabel: 'Supprimer définitivement',
      body: html`<p>Tous les fichiers de l'application seront effacés. Cette action est irréversible.</p>
        <div class="field"><label>Tapez <b>${app.name}</b> pour confirmer</label><input type="text" name="confirm" autocomplete="off" /></div>`,
      onConfirm: async (values) => {
        if (values.confirm !== app.name) throw new Error('Le nom ne correspond pas');
        await api.del(`/apps/${app.id}`);
        return true;
      },
    });
    if (!result) return;
    toast(`« ${app.name} » a été supprimée`);
    await refreshApps();
    location.hash = '#/';
  });
}

// ---- Utilisateurs de l'application ---------------------------------------------------
// Le créateur est toujours en tête de liste et ne peut pas être retiré. Les administrateurs voient toutes les
// applications : ils n'apparaissent pas dans la liste (sauf s'ils ont créé l'application).
async function usersTab(el, page, app) {
  let info = await api.get(`/apps/${app.id}/members`);
  if (!page.active) return;
  const draw = () => {
    const { owner, members, candidates, canManage } = info;
    setHTML(
      el,
      html`<div class="card">
        <div class="card-header">
          <h2>${icon('users')} Utilisateurs de l'application ${tip(
            html`Ces comptes voient l'application et peuvent tout faire dessus : la démarrer, utiliser la console, modifier ses fichiers et ses variables, la déployer.
              Le créateur ne peut pas être retiré. Les administrateurs ont accès à toutes les applications et n'apparaissent pas dans cette liste.
              ${canManage ? '' : html`<br /><br />Seuls le créateur de l'application et les administrateurs peuvent modifier cette liste.`}`,
          )}</h2>
          <span class="spacer"></span>
          <span class="badge plain">${1 + members.length} compte${members.length ? 's' : ''}</span>
        </div>
        <div class="card-body">
          <ul class="member-list">
            <li class="member owner">
              ${owner?.deleted || !owner ? html`<div class="avatar">${icon('user')}</div>` : avatar(owner)}
              <div class="member-name">
                ${owner?.deleted ? html`<span class="muted">Compte supprimé</span>` : owner ? html`<b>${owner.username}</b>` : html`<span class="muted">Créateur inconnu</span>`}
                ${owner?.id === state.user.id ? html` <span class="faint">(vous)</span>` : ''}
              </div>
              <span class="badge accent">${icon('lock')} Créateur</span>
            </li>
            ${members.map(
              (m) => html`<li class="member">
                ${avatar(m)}
                <div class="member-name"><b>${m.username}</b>${m.id === state.user.id ? html` <span class="faint">(vous)</span>` : ''}</div>
                ${canManage ? html`<button class="btn btn-ghost btn-sm" data-remove="${m.id}" data-name="${m.username}">${icon('x')} Retirer</button>` : ''}
              </li>`,
            )}
          </ul>
        </div>
        ${canManage
          ? candidates.length
            ? html`<form class="card-foot member-add" id="member-form">
                <label class="muted nowrap" for="member-user">${icon('userPlus')} Ajouter</label>
                <select id="member-user" name="userId" required>
                  <option value="">Choisir un utilisateur…</option>
                  ${candidates.map((c) => html`<option value="${c.id}">${c.username}</option>`)}
                </select>
                <button class="btn btn-primary" type="submit">${icon('plus')} Donner l'accès</button>
              </form>`
            : html`<div class="card-foot"><span class="muted">Tous les utilisateurs ont déjà accès</span>${isAdmin() ? tip(html`Pour donner accès à quelqu'un d'autre, créez d'abord son compte dans <a href="#/settings/utilisateurs">Paramètres → Utilisateurs</a>.`) : ''}</div>`
          : ''}
      </div>`,
    );

    $('#member-form', el)?.addEventListener('submit', (e) => {
      e.preventDefault();
      const userId = e.target.userId.value;
      if (!userId) return;
      withBusy($('[type=submit]', e.target), async () => {
        info = await api.post(`/apps/${app.id}/members`, { userId });
        if (!page.active) return;
        draw();
        toast('Accès donné');
      });
    });
    el.querySelectorAll('[data-remove]').forEach((button) =>
      button.addEventListener('click', async () => {
        const { remove, name } = button.dataset;
        if (!(await confirmDialog(`Retirer « ${name} » ?`, `${name} ne verra plus cette application et ne pourra plus y accéder.`, { danger: true, confirmLabel: 'Retirer' }))) return;
        await withBusy(button, async () => {
          info = await api.del(`/apps/${app.id}/members/${encodeURIComponent(remove)}`);
          if (!page.active) return;
          draw();
          toast('Accès retiré');
        });
      }),
    );
  };
  draw();
}

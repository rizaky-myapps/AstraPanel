import { api } from '../api.js';
import { isAdmin, onAppsChange, state } from '../state.js';
import { formatWhen, renderLineChart } from '../chart.js';
import { $, ROLE_LABEL, TYPE_INFO, formatBytes, formatDuration, formatPercent, html, icon, setHTML, statusOf } from '../ui.js';

const RANGES = [
  { id: '1h', label: '1 h', refresh: 10_000 },
  { id: '24h', label: '24 h', refresh: 60_000 },
  { id: '15j', label: '15 j', refresh: 120_000 },
  { id: '30j', label: '30 j', refresh: 120_000 },
];

const num = (v, d = 1) => v.toFixed(d).replace('.', ',');

// Les trois courbes : processeur, température, mémoire
const SERIES = [
  {
    id: 'cpu',
    title: 'Processeur',
    icon: 'cpu',
    index: 1,
    format: (v, tick) => (tick ? `${v} %` : formatPercent(v)),
    domain: () => [0, 100],
  },
  {
    id: 'temp',
    title: 'Température',
    icon: 'thermo',
    index: 2,
    format: (v, tick) => (tick ? `${v}°` : `${num(v)} °C`),
    domain: (values) => {
      if (!values.length) return [20, 80];
      let lo = Math.max(0, Math.floor((Math.min(...values) - 5) / 10) * 10);
      let hi = Math.ceil((Math.max(...values) + 5) / 10) * 10;
      if (hi - lo < 20) hi = lo + 20;
      return [lo, hi];
    },
  },
  {
    id: 'mem',
    title: 'Mémoire vive',
    icon: 'memory',
    index: 3,
    scale: 1 / 1024, // les points sont en Mo, le graphique en Go (graduations rondes)
    format: (v, tick) => `${num(v, tick && Number.isInteger(v) ? 0 : 1)} Go`,
    domain: (values, data) => [0, data.memTotal ? data.memTotal / 1024 : Math.max(1, ...values)],
  },
];

// ---- Bureau : horloge, compte, indicateurs ------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const DATE_FORMAT = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const greeting = (hour) => (hour >= 5 && hour < 18 ? 'Bonjour' : 'Bonsoir');
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function accountCard() {
  const { username, role } = state.user;
  return html`<div class="desk-account">
    <div class="desk-avatar" aria-hidden="true">${username.slice(0, 1).toUpperCase()}</div>
    <div class="desk-account-text">
      <div class="desk-hello"><span id="desk-greeting">${greeting(new Date().getHours())}</span>, <b>${username}</b></div>
      <span class="badge ${role === 'admin' ? 'accent' : 'plain'}">${icon(role === 'admin' ? 'shield' : 'user')} ${ROLE_LABEL[role] || role}</span>
    </div>
    <div class="desk-account-actions">
      <a class="btn btn-sm" href="#/settings/compte">${icon('user')} Mon compte</a>
      <button type="button" class="btn btn-sm btn-ghost" data-logout title="Se déconnecter">${icon('logout')} Déconnexion</button>
    </div>
  </div>`;
}

// Indicateurs façon barre d'état : machine, adresse, durée d'allumage, tunnel et mises à jour (administrateurs)
function pills(sys, extra) {
  const ips = sys.addresses.map((a) => a.address).join(', ');
  const out = [
    html`<span class="desk-pill" title="${sys.model}">${icon('server')} ${sys.hostname}</span>`,
    ips ? html`<span class="desk-pill mono">${icon('globe')} ${ips}</span>` : '',
    html`<span class="desk-pill">${icon('clock')} Allumée depuis ${formatDuration(sys.uptime * 1000)}</span>`,
  ];
  const t = extra.tunnel;
  if (t) {
    const links = t.ready?.readyConnections || 0;
    const [cls, label] = !t.enabled
      ? ['', 'Tunnel désactivé']
      : t.running && links > 0
        ? ['ok', `Tunnel connecté · ${links} liaison${links > 1 ? 's' : ''}`]
        : t.running
          ? ['warn', 'Tunnel : connexion…']
          : ['warn', 'Tunnel arrêté'];
    out.push(html`<a class="desk-pill ${cls}" href="#/settings/tunnel">${icon('cloud')} ${label}</a>`);
  }
  const u = extra.update;
  if (u?.available) {
    out.push(html`<a class="desk-pill ok strong" href="#/settings/mises-a-jour">${icon('arrowUpCircle')} Mise à jour ${u.latestVersion} disponible</a>`);
  } else {
    out.push(html`<span class="desk-pill">${icon('logo')} AstraPanel ${sys.panel.version}${u && !u.available ? ' · à jour' : ''}</span>`);
  }
  return out;
}

// ---- Jauges circulaires ----------------------------------------------------------------------------
const RING_R = 42;
const RING_C = 2 * Math.PI * RING_R;
const clampPct = (v) => Math.max(0, Math.min(100, Number(v) || 0));
const level = (pct, warn = 75, err = 90) => (pct >= err ? 'err' : pct >= warn ? 'warn' : '');

function gauges(sys) {
  const { memory: mem, disk } = sys;
  const temp = sys.temperature;
  const list = [
    {
      id: 'cpu',
      label: 'Processeur',
      icon: 'cpu',
      pct: clampPct(sys.cpu),
      value: sys.cpu === null ? '—' : `${Math.round(sys.cpu)} %`,
      detail: `${sys.cpus} cœurs · charge ${num(sys.loadavg[0], 2)}`,
    },
    {
      id: 'mem',
      label: 'Mémoire',
      icon: 'memory',
      pct: clampPct((mem.used / mem.total) * 100),
      value: `${Math.round((mem.used / mem.total) * 100)} %`,
      detail: `${formatBytes(mem.used)} / ${formatBytes(mem.total)}`,
    },
  ];
  if (disk) {
    list.push({
      id: 'disk',
      label: 'Stockage',
      icon: 'disk',
      pct: clampPct((disk.used / disk.total) * 100),
      value: `${Math.round((disk.used / disk.total) * 100)} %`,
      detail: `${formatBytes(disk.free)} libres`,
      href: isAdmin() ? '#/storage' : null,
    });
  }
  list.push({
    id: 'temp',
    label: 'Température',
    icon: 'thermo',
    // 20 °C = jauge vide, 90 °C = pleine ; alerte à 60 °C, danger à 75 °C
    pct: temp === null ? 0 : clampPct(((temp - 20) / 70) * 100),
    level: temp === null ? '' : temp >= 75 ? 'err' : temp >= 60 ? 'warn' : '',
    value: temp === null ? '—' : `${Math.round(temp)} °C`,
    detail: temp === null ? 'Capteur indisponible' : sys.fan !== null ? `Ventilateur ${sys.fan.toLocaleString('fr-FR')} tr/min` : `${num(temp)} °C`,
  });
  return list.map((g) => ({ ...g, level: g.level ?? level(g.pct) }));
}

function gaugeHTML(g) {
  const inner = html`<div class="gauge-ring">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle class="gauge-track" cx="50" cy="50" r="${RING_R}" />
        <circle class="gauge-value" cx="50" cy="50" r="${RING_R}" stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${RING_C.toFixed(2)}" />
      </svg>
      <div class="gauge-center"><span class="gauge-number"></span></div>
    </div>
    <div class="gauge-label">${icon(g.icon)} ${g.label}${g.href ? icon('chevronRight') : ''}</div>
    <div class="gauge-detail"></div>`;
  return g.href
    ? html`<a class="gauge gauge-${g.id}" data-gauge="${g.id}" href="${g.href}" title="Voir ce qui occupe l'espace">${inner}</a>`
    : html`<div class="gauge gauge-${g.id}" data-gauge="${g.id}">${inner}</div>`;
}

// Mise à jour sur place : l'anneau glisse jusqu'à la nouvelle valeur
function updateGauge(el, g) {
  el.classList.toggle('warn', g.level === 'warn');
  el.classList.toggle('err', g.level === 'err');
  el.querySelector('.gauge-value').setAttribute('stroke-dashoffset', (RING_C * (1 - g.pct / 100)).toFixed(2));
  el.querySelector('.gauge-number').textContent = g.value;
  el.querySelector('.gauge-detail').textContent = g.detail;
  el.setAttribute('aria-label', `${g.label} : ${g.value}, ${g.detail}`);
}

// ---- Lanceur d'applications ------------------------------------------------------------------------
function launcher(apps) {
  const running = apps.filter((a) => a.runtime.status === 'running').length;
  return html`<div class="widget-head">
      <h2>${icon('grid')} Applications</h2>
      <span class="muted widget-sub">${apps.length ? `${running} en ligne · ${apps.length} au total` : ''}</span>
    </div>
    <div class="launcher">
      ${apps.map((app) => {
        const s = statusOf(app);
        const type = TYPE_INFO[app.type] || { label: app.type, icon: 'box' };
        const mem = app.runtime.status === 'running' && app.runtime.memory ? ` · ${formatBytes(app.runtime.memory)}` : '';
        return html`<a class="app-tile" href="#/apps/${app.id}" title="${app.name} — ${type.label}">
          <span class="app-tile-icon type-${app.type}">${icon(type.icon)}<span class="dot ${s.cls}"></span></span>
          <span class="app-tile-name">${app.name}</span>
          <span class="app-tile-status">${s.label}${mem}</span>
        </a>`;
      })}
      <a class="app-tile app-tile-new" href="#/new">
        <span class="app-tile-icon">${icon('plus')}</span>
        <span class="app-tile-name">Ajouter</span>
        <span class="app-tile-status">Site ou bot Discord</span>
      </a>
    </div>`;
}
const launcherKey = (apps) => apps.map((a) => `${a.id}:${a.name}:${a.type}:${statusOf(a).label}:${Math.round((a.runtime.memory || 0) / 1048576)}`).join('|');

function renderAlerts(sys) {
  const t = sys.throttling;
  if (!t) return '';
  const out = [];
  if (t.underVoltage) {
    out.push(html`<div class="alert err">${icon('zap')}<div><b>Sous-tension détectée.</b> L'alimentation de la machine est insuffisante : elle ralentit et peut planter. Utilisez l'alimentation recommandée par le fabricant.</div></div>`);
  } else if (t.underVoltageOccurred) {
    out.push(html`<div class="alert warn">${icon('zap')}<div>Une sous-tension a eu lieu depuis le démarrage. Vérifiez l'alimentation et son câble.</div></div>`);
  }
  if (t.throttled || t.softTempLimit) {
    out.push(html`<div class="alert warn">${icon('thermo')}<div>Le processeur est bridé à cause de la chaleur. Améliorez le refroidissement de la machine (ventilateur, dissipateur, aération).</div></div>`);
  }
  return out;
}

function savedRange() {
  try {
    const r = localStorage.getItem('astra.range');
    return RANGES.some((x) => x.id === r) ? r : '1h';
  } catch {
    return '1h';
  }
}

export function renderDashboard(view, page) {
  const root = document.createElement('div');
  view.replaceChildren(root);
  let range = savedRange();
  let data = null;

  setHTML(
    root,
    html`<section class="desk-hero">
        <div class="desk-clock">
          <div class="desk-time" aria-live="off"><span id="clock-hm">--:--</span><span class="desk-seconds" id="clock-s">--</span></div>
          <div class="desk-date" id="clock-date"></div>
          <div class="desk-pills" id="desk-pills"></div>
        </div>
        ${accountCard()}
      </section>
      <div id="sys-alerts"></div>
      <section class="widget">
        <div class="widget-head">
          <h2>${icon('server')} Système</h2>
          <span class="muted widget-sub" id="desk-model"></span>
        </div>
        <div class="gauges" id="gauges"></div>
      </section>
      <section class="widget" id="launcher"></section>
      <div class="section-title">
        <h2>Historique</h2>
        <div class="segmented" role="group" aria-label="Période affichée">
          ${RANGES.map((r) => html`<button type="button" data-range="${r.id}" aria-pressed="${r.id === range}">${r.label}</button>`)}
        </div>
      </div>
      <div class="grid charts" id="charts">
        ${SERIES.map(
          (s) => html`<div class="card chart-card" data-series="${s.id}">
            <div class="chart-head">
              <h3>${icon(s.icon)} ${s.title}</h3>
              <span class="chart-summary"></span>
            </div>
            <div class="chart-body"></div>
            <details class="chart-data">
              <summary>Voir les données</summary>
              <div class="table-scroll"></div>
            </details>
          </div>`,
        )}
      </div>`,
  );

  const chartsBox = $('#charts', root);
  const seriesPoints = (s) => data.points.map((p) => [p[0], p[s.index] === null ? null : p[s.index] * (s.scale || 1)]);

  function drawCharts() {
    if (!data || !page.active) return;
    chartsBox.classList.remove('loading');
    const end = data.now;
    const start = end - data.span;
    for (const s of SERIES) {
      const card = chartsBox.querySelector(`[data-series="${s.id}"]`);
      const points = seriesPoints(s);
      const values = points.map((p) => p[1]).filter((v) => v !== null && v !== undefined);
      const summary = card.querySelector('.chart-summary');
      summary.textContent = values.length
        ? `Actuel ${s.format(values.at(-1))} · moy. ${s.format(values.reduce((a, b) => a + b, 0) / values.length)} · max ${s.format(Math.max(...values))}`
        : '';
      renderLineChart(card.querySelector('.chart-body'), {
        points,
        start,
        end,
        step: data.step,
        domain: s.domain(values, data),
        format: s.format,
        label: `${s.title} sur ${RANGES.find((r) => r.id === range).label}`,
      });
      const details = card.querySelector('details');
      if (details.open) fillTable(card, s, points);
    }
  }

  function fillTable(card, s, points) {
    const rows = points.filter((p) => p[1] !== null && p[1] !== undefined).reverse();
    setHTML(
      card.querySelector('.table-scroll'),
      html`<table class="table compact">
        <thead><tr><th>Moment</th><th class="num">${s.title}</th></tr></thead>
        <tbody>${rows.map((p) => html`<tr><td>${formatWhen(p[0], data.step)}</td><td class="num">${s.format(p[1])}</td></tr>`)}</tbody>
      </table>`,
    );
  }

  chartsBox.addEventListener(
    'toggle',
    (e) => {
      const card = e.target.closest('[data-series]');
      if (!card || !e.target.open || !data) return;
      const s = SERIES.find((x) => x.id === card.dataset.series);
      fillTable(card, s, seriesPoints(s));
    },
    true,
  );

  let metricsTimer = null;
  async function loadMetrics() {
    clearTimeout(metricsTimer);
    const asked = range;
    try {
      const result = await api.get(`/system/metrics?range=${asked}`);
      if (!page.active || asked !== range) return;
      data = result;
      drawCharts();
    } catch {
      // nouvel essai au prochain rafraîchissement
    }
    if (page.active) metricsTimer = setTimeout(loadMetrics, RANGES.find((r) => r.id === range).refresh);
  }

  root.querySelector('.segmented').addEventListener('click', (e) => {
    const button = e.target.closest('[data-range]');
    if (!button || button.dataset.range === range) return;
    range = button.dataset.range;
    try {
      localStorage.setItem('astra.range', range);
    } catch {
      // stockage indisponible : on garde le choix pour cette page seulement
    }
    root.querySelectorAll('[data-range]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === range)));
    chartsBox.classList.add('loading'); // on garde l'ancien tracé, atténué, pendant le chargement
    loadMetrics();
  });

  let resizeTimer = null;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawCharts, 150);
  };
  window.addEventListener('resize', onResize);

  // Horloge : mise à jour à chaque seconde, calée sur le changement de seconde
  let clockTimer = null;
  const tick = () => {
    const now = new Date();
    $('#clock-hm', root).textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    $('#clock-s', root).textContent = pad(now.getSeconds());
    $('#clock-date', root).textContent = capitalize(DATE_FORMAT.format(now));
    $('#desk-greeting', root).textContent = greeting(now.getHours());
    clockTimer = setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
  };
  tick();

  root.querySelector('[data-logout]').addEventListener('click', () => document.getElementById('logout')?.click());

  // Lanceur : redessiné seulement quand une application change
  let shownApps = null;
  const drawLauncher = () => {
    const key = launcherKey(state.apps);
    if (key === shownApps) return;
    shownApps = key;
    setHTML($('#launcher', root), launcher(state.apps));
  };
  drawLauncher();
  page.onCleanup(onAppsChange(drawLauncher));

  // Tunnel et mises à jour (administrateurs), relus moins souvent
  const extra = { tunnel: null, update: null };
  let lastSys = null;
  const drawPills = () => lastSys && setHTML($('#desk-pills', root), pills(lastSys, extra));
  let extraTimer = null;
  const loadExtra = async () => {
    if (!isAdmin()) return;
    const [tunnel, update] = await Promise.all([api.get('/tunnel').catch(() => null), api.get('/update').catch(() => null)]);
    if (!page.active) return;
    Object.assign(extra, { tunnel, update });
    drawPills();
    extraTimer = setTimeout(loadExtra, 30_000);
  };

  let shownGauges = null;
  const loadSystem = async () => {
    try {
      const sys = await api.get('/system');
      if (!page.active) return;
      lastSys = sys;
      drawPills();
      $('#desk-model', root).textContent = sys.model;
      const list = gauges(sys);
      const box = $('#gauges', root);
      const ids = list.map((g) => g.id).join(',');
      if (ids !== shownGauges) {
        shownGauges = ids;
        setHTML(box, list.map(gaugeHTML));
        box.getBoundingClientRect(); // l'anneau part de zéro puis glisse jusqu'à la valeur
      }
      list.forEach((g) => updateGauge(box.querySelector(`[data-gauge="${g.id}"]`), g));
      setHTML($('#sys-alerts', root), renderAlerts(sys));
    } catch {
      // le prochain rafraîchissement réessaiera
    }
  };
  loadSystem();
  loadExtra();
  loadMetrics();
  const timer = setInterval(loadSystem, 4000);
  page.onCleanup(() => {
    clearInterval(timer);
    clearTimeout(clockTimer);
    clearTimeout(extraTimer);
    clearTimeout(metricsTimer);
    window.removeEventListener('resize', onResize);
  });
}

import { api } from '../api.js';
import { isAdmin, onAppsChange, state } from '../state.js';
import { renderLineChart } from '../chart.js';
import { $, TYPE_INFO, formatBytes, formatDuration, formatPercent, html, icon, setHTML, statusOf } from '../ui.js';

const RANGES = [
  { id: '1h', label: '1 h', refresh: 10_000 },
  { id: '12h', label: '12 h', refresh: 60_000 },
  { id: '24h', label: '24 h', refresh: 60_000 },
  { id: '3j', label: '3 j', refresh: 120_000 },
  { id: '7j', label: '7 j', refresh: 120_000 },
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

// ---- Bureau : horloge et date ------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const DATE_FORMAT = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// ---- Jauges : anneau, valeur, mini-courbe des dernières minutes -------------------------------------
const RING_R = 42;
const RING_C = 2 * Math.PI * RING_R;
const clampPct = (v) => Math.max(0, Math.min(100, Number(v) || 0));
const level = (pct, warn = 75, err = 90) => (pct >= err ? 'err' : pct >= warn ? 'warn' : '');
const SPARK_SPAN = 30 * 60_000; // mini-courbes : 30 dernières minutes

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
      spark: sys.cpu,
    },
    {
      id: 'mem',
      label: 'Mémoire',
      icon: 'memory',
      pct: clampPct((mem.used / mem.total) * 100),
      value: `${Math.round((mem.used / mem.total) * 100)} %`,
      detail: `${formatBytes(mem.used)} sur ${formatBytes(mem.total)}`,
      spark: (mem.used / mem.total) * 100,
    },
  ];
  if (disk) {
    list.push({
      id: 'disk',
      label: 'Stockage',
      icon: 'disk',
      pct: clampPct((disk.used / disk.total) * 100),
      value: `${Math.round((disk.used / disk.total) * 100)} %`,
      detail: `${formatBytes(disk.free)} libres sur ${formatBytes(disk.total)}`,
      href: isAdmin() ? '/storage' : null,
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
    spark: temp,
  });
  return list.map((g) => ({ ...g, level: g.level ?? level(g.pct) }));
}

function gaugeHTML(g) {
  const inner = html`<div class="dash-stat-main">
      <div class="gauge-ring">
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <circle class="gauge-track" cx="50" cy="50" r="${RING_R}" />
          <circle class="gauge-value" cx="50" cy="50" r="${RING_R}" stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${RING_C.toFixed(2)}" />
        </svg>
        <span class="gauge-icon">${icon(g.icon)}</span>
      </div>
      <div class="dash-stat-text">
        <span class="dash-stat-label">${g.label}${g.href ? icon('chevronRight') : ''}</span>
        <span class="gauge-number"></span>
        <span class="gauge-detail"></span>
      </div>
    </div>
    ${g.id === 'disk'
      ? html`<div class="dash-bar" aria-hidden="true"><i></i></div>`
      : html`<svg class="dash-spark" viewBox="0 0 200 44" preserveAspectRatio="none" aria-hidden="true"><path class="spark-area" /><path class="spark-line" /></svg>`}`;
  return g.href
    ? html`<a class="dash-stat gauge gauge-${g.id}" data-gauge="${g.id}" href="${g.href}" title="Voir ce qui occupe l'espace">${inner}</a>`
    : html`<div class="dash-stat gauge gauge-${g.id}" data-gauge="${g.id}">${inner}</div>`;
}

// Mini-courbe : [[t, valeur]] sur les 30 dernières minutes, dans le cadre 200 × 44 du SVG
function sparkPaths(points, now, [lo, hi]) {
  const pts = points.filter((p) => p[1] !== null && p[1] !== undefined && p[0] >= now - SPARK_SPAN);
  if (pts.length < 2) return null;
  // moins de 30 minutes de mesures (page ou panel ouvert depuis peu) : la courbe occupe quand même toute la largeur
  const from = pts[0][0];
  const span = Math.max(60_000, now - from);
  const x = (t) => ((t - from) / span) * 200;
  const y = (v) => 42 - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo || 1)) * 38;
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
  return { line, area: `${line}L${x(pts.at(-1)[0]).toFixed(1)},44L${x(pts[0][0]).toFixed(1)},44Z` };
}

// Mise à jour sur place : l'anneau glisse jusqu'à la nouvelle valeur, la courbe avance
function updateGauge(el, g, history) {
  el.classList.toggle('warn', g.level === 'warn');
  el.classList.toggle('err', g.level === 'err');
  el.querySelector('.gauge-value').setAttribute('stroke-dashoffset', (RING_C * (1 - g.pct / 100)).toFixed(2));
  el.querySelector('.gauge-number').textContent = g.value;
  el.querySelector('.gauge-detail').textContent = g.detail;
  el.setAttribute('aria-label', `${g.label} : ${g.value}, ${g.detail}`);
  const bar = el.querySelector('.dash-bar i');
  if (bar) bar.style.width = `${g.pct}%`;
  const spark = el.querySelector('.dash-spark');
  if (spark) {
    const values = history.map((p) => p[1]).filter((v) => v !== null && v !== undefined);
    const domain = g.id === 'temp' && values.length ? [Math.min(...values) - 4, Math.max(...values) + 4] : [0, 100];
    const paths = sparkPaths(history, Date.now(), domain);
    spark.querySelector('.spark-line').setAttribute('d', paths?.line || '');
    spark.querySelector('.spark-area').setAttribute('d', paths?.area || '');
  }
}

// ---- Applications : une tuile par appli, avec sa charge en direct ------------------------------------
function appTile(app, maxMem) {
  const s = statusOf(app);
  const type = TYPE_INFO[app.type] || { label: app.type, icon: 'box' };
  const rt = app.runtime;
  const running = rt.status === 'running';
  const cpu = running && rt.cpu !== null ? rt.cpu : null;
  const mem = running && rt.memory ? rt.memory : null;
  const where = app.domains?.[0] || (app.port ? `port ${app.port}` : type.label);
  return html`<a class="dash-app" href="/apps/${app.id}" title="${app.name} — ${type.label}">
    <span class="dash-app-head">
      <span class="app-tile-icon type-${app.type}">${icon(type.icon)}</span>
      <span class="dash-app-name"><b>${app.name}</b><span class="dash-app-sub"><span class="dot ${s.cls}"></span><span class="dash-app-state ${s.cls}">${s.label}</span> · ${where}</span></span>
    </span>
    <span class="dash-app-meters">
      <span class="dash-meter"><span>Processeur</span><b>${cpu === null ? '—' : formatPercent(cpu)}</b><i style="--v: ${cpu === null ? 0 : Math.min(100, cpu)}%"></i></span>
      <span class="dash-meter mem"><span>Mémoire</span><b>${mem === null ? '—' : formatBytes(mem)}</b><i style="--v: ${mem === null ? 0 : Math.max(4, (mem / maxMem) * 100)}%"></i></span>
    </span>
  </a>`;
}

function launcher(apps) {
  const running = apps.filter((a) => a.runtime.status === 'running').length;
  const maxMem = Math.max(64 * 1048576, ...apps.map((a) => a.runtime.memory || 0));
  return html`<div class="widget-head">
      <h2>${icon('grid')} Applications</h2>
      <span class="dash-count">${apps.length ? html`<b>${running}</b> / ${apps.length} en ligne` : ''}</span>
    </div>
    <div class="dash-apps">
      ${apps.map((app) => appTile(app, maxMem))}
      <a class="dash-app dash-app-new" href="/new">
        <span class="dash-app-plus">${icon('plus')}</span>
        <b>Nouvelle application</b>
      </a>
    </div>`;
}
const launcherKey = (apps) =>
  apps
    .map((a) => `${a.id}:${a.name}:${a.type}:${a.domains?.[0] || a.port}:${statusOf(a).label}:${Math.round(a.runtime.cpu || 0)}:${Math.round((a.runtime.memory || 0) / 1048576)}`)
    .join('|');

// ---- Machine : nom, système, durée depuis le démarrage, adresse ----------------------------------------
function machineHTML(sys) {
  const row = (ic, label, value) => html`<li><span class="dash-machine-icon">${icon(ic)}</span><span>${label}</span><b>${value}</b></li>`;
  return html`<div class="widget-head"><h2>${icon('server')} Machine</h2></div>
    <div class="dash-machine-name">${sys.hostname}</div>
    <div class="dash-machine-model">${sys.model}</div>
    <ul class="dash-machine-list">
      ${row('clock', 'Allumée depuis', formatDuration(sys.uptime * 1000))}
      ${sys.addresses?.[0] ? row('link', 'Adresse IP', sys.addresses[0].address) : ''}
      ${row('box', 'Node.js', sys.node.replace(/^v/, ''))}
      ${row('logo', 'AstraPanel', sys.panel?.version || '—')}
    </ul>`;
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
    html`<div class="dash"><section class="desk-hero">
        <div class="desk-clock">
          <div class="desk-time" aria-live="off"><span id="clock-hm">--:--</span><span class="desk-seconds" id="clock-s">--</span></div>
          <div class="desk-date" id="clock-date"></div>
        </div>
      </section>
      <section class="dash-stats" id="gauges" aria-label="Machine en direct"></section>
      <div class="dash-row">
        <section class="widget dash-apps-widget" id="launcher"></section>
        <section class="widget dash-machine" id="machine"></section>
      </div>
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
          </div>`,
        )}
      </div></div>`,
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
    }
  }

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
    clockTimer = setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
  };
  tick();


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

  let shownGauges = null;
  let shownMachine = '';
  // mini-courbes : historique de la dernière heure, puis une mesure à chaque rafraîchissement
  const history = { cpu: [], mem: [], temp: [] };
  const remember = (id, t, v) => {
    const list = history[id];
    if (!list || v === null || v === undefined) return;
    list.push([t, v]);
    while (list.length && list[0][0] < t - SPARK_SPAN) list.shift();
  };
  let last = null;
  const drawGauges = () => {
    if (!last || !page.active) return;
    const list = gauges(last);
    const box = $('#gauges', root);
    const ids = list.map((g) => g.id).join(',');
    if (ids !== shownGauges) {
      shownGauges = ids;
      setHTML(box, list.map(gaugeHTML));
      box.getBoundingClientRect(); // l'anneau part de zéro puis glisse jusqu'à la valeur
    }
    list.forEach((g) => updateGauge(box.querySelector(`[data-gauge="${g.id}"]`), g, history[g.id] || []));
  };
  const loadSystem = async () => {
    try {
      const sys = await api.get('/system');
      if (!page.active) return;
      last = sys;
      const now = Date.now();
      for (const g of gauges(sys)) remember(g.id, now, g.spark);
      drawGauges();
      const machine = machineHTML(sys);
      if (String(machine) !== shownMachine) {
        shownMachine = String(machine);
        setHTML($('#machine', root), machine);
      }
    } catch {
      // le prochain rafraîchissement réessaiera
    }
  };
  api
    .get('/system/metrics?range=1h')
    .then((d) => {
      if (!page.active) return;
      const seed = { cpu: [], mem: [], temp: [] };
      for (const [t, cpu, temp, mem] of d.points) {
        if (t < Date.now() - SPARK_SPAN) continue;
        seed.cpu.push([t, cpu]);
        seed.temp.push([t, temp]);
        if (d.memTotal && mem !== null) seed.mem.push([t, (mem / d.memTotal) * 100]);
      }
      // les mesures de l'historique passent avant celles prises depuis l'ouverture de la page
      for (const id of Object.keys(history)) history[id] = [...seed[id].filter((p) => p[1] !== null), ...history[id]];
      drawGauges();
    })
    .catch(() => {});
  loadSystem();
  loadMetrics();
  const timer = setInterval(loadSystem, 4000);
  page.onCleanup(() => {
    clearInterval(timer);
    clearTimeout(clockTimer);
    clearTimeout(metricsTimer);
    window.removeEventListener('resize', onResize);
  });
}

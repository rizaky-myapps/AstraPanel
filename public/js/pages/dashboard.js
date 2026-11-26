import { api } from '../api.js';
import { isAdmin } from '../state.js';
import { formatWhen, renderLineChart } from '../chart.js';
import { $, formatBytes, formatDuration, formatPercent, html, icon, setHTML } from '../ui.js';

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

function bar(ratio) {
  const pct = Math.max(0, Math.min(100, ratio * 100));
  const cls = pct > 90 ? 'err' : pct > 75 ? 'warn' : '';
  return html`<div class="bar ${cls}"><i style="width:${pct.toFixed(1)}%"></i></div>`;
}

function stat(iconName, label, value, detail, extra = '') {
  return html`<div class="label">${icon(iconName)} ${label}</div>
    <div class="value">${value}</div>
    <div class="detail">${detail}</div>
    ${extra}`;
}

function renderStats(sys) {
  const temp = sys.temperature;
  const tempCls = temp === null ? '' : temp < 60 ? 'temp-ok' : temp < 75 ? 'temp-warn' : 'temp-err';
  const { memory: mem, disk } = sys;
  const cards = [
    html`<div class="card stat">${stat(
      'cpu',
      'Processeur',
      formatPercent(sys.cpu),
      `Charge ${sys.loadavg.map((l) => num(l, 2)).join(' · ')} — ${sys.cpus} cœurs`,
      bar((sys.cpu || 0) / 100),
    )}</div>`,
    html`<div class="card stat">${stat(
      'thermo',
      'Température',
      temp === null ? '—' : html`<span class="${tempCls}">${num(temp)} °C</span>`,
      sys.fan !== null ? `Ventilateur : ${sys.fan} tr/min` : temp === null ? 'Capteur indisponible' : 'Ventilateur non détecté',
    )}</div>`,
    html`<div class="card stat">${stat(
      'memory',
      'Mémoire',
      html`${formatBytes(mem.used)} <small>/ ${formatBytes(mem.total)}</small>`,
      `${formatBytes(mem.available)} disponibles`,
      bar(mem.used / mem.total),
    )}</div>`,
  ];
  if (disk) {
    const body = stat(
      'disk',
      'Stockage',
      html`${formatBytes(disk.used)} <small>/ ${formatBytes(disk.total)}</small>`,
      html`${formatBytes(disk.free)} libres${isAdmin() ? html` <span class="stat-link">Détails ${icon('chevronRight')}</span>` : ''}`,
      bar(disk.used / disk.total),
    );
    cards.push(isAdmin() ? html`<a class="card stat clickable" href="#/storage" title="Voir ce qui occupe l'espace">${body}</a>` : html`<div class="card stat">${body}</div>`);
  }
  cards.push(html`<div class="card stat">${stat('clock', 'En ligne depuis', formatDuration(sys.uptime * 1000), `Node.js ${sys.node} — panel v${sys.panel.version}`)}</div>`);
  return cards;
}

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
    html`<div class="page-header">
        <div>
          <h1>Tableau de bord</h1>
          <div class="sub" id="host-line">Chargement…</div>
        </div>
      </div>
      <div id="sys-alerts"></div>
      <div class="grid stats" id="stats"></div>
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

  const loadSystem = async () => {
    try {
      const sys = await api.get('/system');
      if (!page.active) return;
      const ips = sys.addresses.map((a) => a.address).join(', ');
      $('#host-line', root).textContent = `${sys.model} · ${sys.hostname}${ips ? ` · IP ${ips}` : ''}`;
      setHTML($('#stats', root), renderStats(sys));
      setHTML($('#sys-alerts', root), renderAlerts(sys));
    } catch {
      // le prochain rafraîchissement réessaiera
    }
  };
  loadSystem();
  loadMetrics();
  const timer = setInterval(loadSystem, 4000);
  page.onCleanup(() => {
    clearInterval(timer);
    clearTimeout(metricsTimer);
    window.removeEventListener('resize', onResize);
  });
}

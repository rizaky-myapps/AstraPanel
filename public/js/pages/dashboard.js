import { api } from '../api.js';
import { onAppsChange, refreshApps, state } from '../state.js';
import {
  $,
  TYPE_INFO,
  domainUrl,
  formatBytes,
  formatDuration,
  formatPercent,
  html,
  icon,
  localUrl,
  setHTML,
  statusBadge,
  withBusy,
} from '../ui.js';

function bar(ratio) {
  const pct = Math.max(0, Math.min(100, ratio * 100));
  const cls = pct > 90 ? 'err' : pct > 75 ? 'warn' : '';
  return html`<div class="bar ${cls}"><i style="width:${pct.toFixed(1)}%"></i></div>`;
}

function stat(iconName, label, value, detail, extra = '') {
  return html`<div class="card stat">
    <div class="label">${icon(iconName)} ${label}</div>
    <div class="value">${value}</div>
    <div class="detail">${detail}</div>
    ${extra}
  </div>`;
}

function renderStats(sys) {
  const temp = sys.temperature;
  const tempCls = temp === null ? '' : temp < 60 ? 'temp-ok' : temp < 75 ? 'temp-warn' : 'temp-err';
  const mem = sys.memory;
  const disk = sys.disk;
  return [
    stat(
      'cpu',
      'Processeur',
      formatPercent(sys.cpu),
      `Charge ${sys.loadavg.map((l) => l.toFixed(2).replace('.', ',')).join(' · ')} — ${sys.cpus} cœurs`,
      bar((sys.cpu || 0) / 100),
    ),
    stat(
      'thermo',
      'Température',
      temp === null ? '—' : html`<span class="${tempCls}">${temp.toFixed(1).replace('.', ',')} °C</span>`,
      sys.fan !== null ? `Ventilateur : ${sys.fan} tr/min` : temp === null ? 'Capteur indisponible' : 'Ventilateur non détecté',
    ),
    stat(
      'memory',
      'Mémoire',
      html`${formatBytes(mem.used)} <small>/ ${formatBytes(mem.total)}</small>`,
      `${formatBytes(mem.available)} disponibles`,
      bar(mem.used / mem.total),
    ),
    disk
      ? stat(
          'disk',
          'Stockage',
          html`${formatBytes(disk.used)} <small>/ ${formatBytes(disk.total)}</small>`,
          `${formatBytes(disk.free)} libres`,
          bar(disk.used / disk.total),
        )
      : '',
    stat('clock', 'En ligne depuis', formatDuration(sys.uptime * 1000), `Node.js ${sys.node} — panel v${sys.panel.version}`),
  ];
}

function renderAlerts(sys) {
  const t = sys.throttling;
  if (!t) return '';
  const out = [];
  if (t.underVoltage) {
    out.push(html`<div class="alert err">${icon('zap')}<div><b>Sous-tension détectée.</b> Utilisez l'alimentation officielle 27 W (5 V / 5 A) du Raspberry Pi 5, sinon le Pi ralentit et peut planter.</div></div>`);
  } else if (t.underVoltageOccurred) {
    out.push(html`<div class="alert warn">${icon('zap')}<div>Une sous-tension a eu lieu depuis le démarrage. Vérifiez l'alimentation et le câble USB-C.</div></div>`);
  }
  if (t.throttled || t.softTempLimit) {
    out.push(html`<div class="alert warn">${icon('thermo')}<div>Le processeur est bridé à cause de la chaleur. Un dissipateur ou l'Active Cooler est recommandé.</div></div>`);
  }
  return out;
}

function appCard(app) {
  const type = TYPE_INFO[app.type];
  const running = app.runtime.status === 'running';
  const busy = Boolean(app.runtime.busy);
  const url = localUrl(app);
  return html`<div class="card app-card" data-id="${app.id}">
    <div class="head">
      <div class="app-icon ${app.type}">${icon(type.icon)}</div>
      <div class="truncate">
        <div class="name truncate">${app.name}</div>
        <div class="muted truncate">${type.label}${app.port ? ` · :${app.port}` : ''}</div>
      </div>
      <span class="spacer"></span>
      ${statusBadge(app)}
    </div>
    <div class="metrics">
      <span title="Processeur">${icon('cpu')} ${running ? formatPercent(app.runtime.cpu) : '—'}</span>
      <span title="Mémoire">${icon('memory')} ${running ? formatBytes(app.runtime.memory) : '—'}</span>
      <span title="Durée de fonctionnement">${icon('clock')} ${running ? formatDuration(Date.now() - app.runtime.startedAt) : '—'}</span>
    </div>
    <div class="actions">
      ${running || app.runtime.status === 'restarting'
        ? html`<button class="btn btn-sm" data-action="stop" ${busy ? 'disabled' : ''}>${icon('stop')} Arrêter</button>
            <button class="btn btn-sm btn-ghost" data-action="restart" ${busy ? 'disabled' : ''}>${icon('restart')} Redémarrer</button>`
        : html`<button class="btn btn-sm btn-success" data-action="start" ${busy ? 'disabled' : ''}>${icon('play')} Démarrer</button>`}
      <span class="spacer"></span>
      ${app.domains?.length
        ? html`<a class="btn btn-sm btn-ghost" href="${domainUrl(app.domains[0])}" target="_blank" rel="noopener" data-link>${icon('external')} ${app.domains[0]}</a>`
        : url
          ? html`<a class="btn btn-sm btn-ghost" href="${url}" target="_blank" rel="noopener" data-link>${icon('external')} Ouvrir</a>`
          : ''}
    </div>
  </div>`;
}

export function renderDashboard(view, page) {
  setHTML(
    view,
    html`<div class="page-header">
        <div>
          <h1>Tableau de bord</h1>
          <div class="sub" id="host-line">Chargement…</div>
        </div>
        <span class="spacer"></span>
        <a class="btn btn-primary" href="#/new">${icon('plus')} Nouvelle application</a>
      </div>
      <div id="sys-alerts"></div>
      <div class="grid stats" id="stats"></div>
      <div class="section-title">
        <h2>Applications</h2>
        <span class="muted" id="apps-count"></span>
      </div>
      <div id="apps"></div>`,
  );

  const appsBox = $('#apps', view);
  const renderApps = (apps) => {
    $('#apps-count', view).textContent = apps.length
      ? `${apps.filter((a) => a.runtime.status === 'running').length} en ligne sur ${apps.length}`
      : '';
    if (!apps.length) {
      setHTML(
        appsBox,
        html`<div class="card empty">
          <div class="app-icon lg">${icon('sparkles')}</div>
          <h2>Aucune application pour l'instant</h2>
          <p>Hébergez votre premier bot Discord ou site web en quelques clics.</p>
          <a class="btn btn-primary" href="#/new">${icon('plus')} Créer une application</a>
        </div>`,
      );
      return;
    }
    appsBox.className = 'grid apps';
    setHTML(appsBox, apps.map(appCard));
  };
  renderApps(state.apps);
  page.onCleanup(onAppsChange(renderApps));

  appsBox.addEventListener('click', (e) => {
    if (e.target.closest('[data-link]')) return;
    const card = e.target.closest('.app-card');
    if (!card) return;
    const button = e.target.closest('[data-action]');
    if (!button) {
      location.hash = `#/apps/${card.dataset.id}`;
      return;
    }
    withBusy(button, async () => {
      await api.post(`/apps/${card.dataset.id}/${button.dataset.action}`);
      await refreshApps();
    });
  });

  const loadSystem = async () => {
    try {
      const sys = await api.get('/system');
      if (!page.active) return;
      const ips = sys.addresses.map((a) => a.address).join(', ');
      $('#host-line', view).textContent = `${sys.model} · ${sys.hostname}${ips ? ` · IP ${ips}` : ''}`;
      setHTML($('#stats', view), renderStats(sys));
      setHTML($('#sys-alerts', view), renderAlerts(sys));
    } catch {
      // le prochain rafraîchissement réessaiera
    }
  };
  loadSystem();
  const timer = setInterval(loadSystem, 4000);
  page.onCleanup(() => clearInterval(timer));
}

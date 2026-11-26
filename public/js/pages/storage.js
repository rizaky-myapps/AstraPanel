import { api, qs } from '../api.js';
import { isAdmin } from '../state.js';
import { $, formatBytes, formatDate, html, icon, pageHero, setHTML, tip } from '../ui.js';

function usageBar(ratio) {
  const pct = Math.max(0, Math.min(100, ratio * 100));
  const cls = pct > 90 ? 'err' : pct > 75 ? 'warn' : '';
  return html`<div class="bar ${cls}"><i style="width:${pct.toFixed(1)}%"></i></div>`;
}

const storageHref = (p) => `#/storage/${encodeURIComponent(p)}`;

export async function renderStorage(view, page, encodedPath) {
  if (!isAdmin()) {
    setHTML(view, html`<div class="alert warn">${icon('shield')}<div>Cette page est réservée aux administrateurs.</div></div>`);
    return;
  }
  let current = null;
  try {
    current = encodedPath ? decodeURIComponent(encodedPath) : null;
  } catch {
    current = null;
  }
  const root = document.createElement('div');
  view.replaceChildren(root);
  setHTML(
    root,
    html`<a class="back" href="#/">${icon('back')} Tableau de bord</a>
      ${pageHero({ icon: 'disk', tone: 'blue', title: 'Stockage', info: 'Les emplacements de stockage de la machine et ce qui y occupe de la place.' })}
      <div class="grid mounts" id="mounts"><div class="card stat"><div class="spinner sm"></div></div></div>
      <div id="analysis"></div>`,
  );

  const info = await api.get('/storage');
  if (!page.active) return;
  setHTML(
    $('#mounts', root),
    info.mounts.map((m) => {
      const active = current && (current === m.mount || current.startsWith(m.mount === '/' ? '/' : `${m.mount}/`));
      return html`<a class="card stat clickable mount ${active ? 'active' : ''}" href="${storageHref(m.mount)}">
        <div class="label">${icon('disk')} <span class="mono">${m.mount}</span></div>
        <div class="value">${formatBytes(m.used)} <small>/ ${formatBytes(m.total)}</small></div>
        <div class="detail">${formatBytes(m.free)} libres · ${m.device} (${m.fstype})</div>
        ${usageBar(m.used / m.total)}
      </a>`;
    }),
  );

  const box = $('#analysis', root);
  if (!current) {
    setHTML(
      box,
      html`<div class="card empty">
        <div class="app-icon lg">${icon('disk')}</div>
        <h2>Choisissez un emplacement ${tip('Cliquez sur un disque pour voir ses dossiers et fichiers, du plus lourd au plus léger.')}</h2>
        <div class="row" style="justify-content:center">
          <a class="btn" href="${storageHref(info.appsDir)}">${icon('folder')} Dossier des applications</a>
          <a class="btn btn-ghost" href="${storageHref(info.dataDir)}">${icon('server')} Données du panel</a>
        </div>
      </div>`,
    );
    return;
  }

  const analyze = async (refresh = false) => {
    setHTML(
      box,
      html`<div class="card">
        <div class="card-body row"><div class="spinner sm"></div><span class="muted">Analyse de <span class="mono">${current}</span>… (jusqu'à une minute sur un disque lent)</span></div>
      </div>`,
    );
    let result;
    try {
      result = await api.get(`/storage/analyze?${qs({ path: current, refresh: refresh ? '1' : '0' })}`);
    } catch (err) {
      if (page.active) setHTML(box, html`<div class="alert err">${icon('alert')}<div>${err.message}</div></div>`);
      return;
    }
    if (!page.active) return;
    const parts = current.split('/').filter(Boolean);
    const biggest = result.entries[0]?.size || 1;
    setHTML(
      box,
      html`<div class="card">
        <div class="card-header">
          <div class="crumbs">
            <a href="${storageHref('/')}">${icon('disk')} /</a>
            ${parts.map((p, i) => html`<span class="sep">/</span><a href="${storageHref(`/${parts.slice(0, i + 1).join('/')}`)}">${p}</a>`)}
          </div>
          <span class="spacer"></span>
          <span class="muted nowrap hide-sm">Total : <b>${formatBytes(result.total)}</b></span>
          <button class="btn btn-ghost btn-sm" data-refresh title="Analysé le ${formatDate(result.at)}">${icon('refresh')} Actualiser</button>
        </div>
        ${result.denied
          ? html`<div class="alert warn" style="margin:14px 18px 0">${icon('shield')}<div>${result.denied} dossier(s) système ne sont pas lisibles par le panel : leur taille n'est pas comptée.</div></div>`
          : ''}
        <div class="usage-list">
          ${result.parent ? html`<a class="usage-row" href="${storageHref(result.parent)}"><span class="usage-name">${icon('up')} ..</span></a>` : ''}
          ${result.entries.length ? '' : html`<div class="usage-row muted">Dossier vide.</div>`}
          ${result.entries.map((e) => {
            const content = html`<span class="usage-name ${e.type}">${icon(e.type === 'dir' ? 'folder' : 'file')}<span class="truncate">${e.name}</span></span>
              <span class="usage-bar"><i style="width:${Math.max(0.5, (e.size / biggest) * 100).toFixed(1)}%"></i></span>
              <span class="usage-size">${formatBytes(e.size)}</span>
              <span class="usage-pct hide-sm">${result.total ? `${((e.size / result.total) * 100).toFixed(1).replace('.', ',')} %` : ''}</span>`;
            return e.type === 'dir'
              ? html`<a class="usage-row" href="${storageHref(e.path)}">${content}</a>`
              : html`<div class="usage-row">${content}</div>`;
          })}
          ${result.hidden ? html`<div class="usage-row muted">… et ${result.hidden} autres éléments (${formatBytes(result.hiddenSize)})</div>` : ''}
        </div>
      </div>`,
    );
    box.querySelector('[data-refresh]').addEventListener('click', () => analyze(true));
  };
  analyze();
}

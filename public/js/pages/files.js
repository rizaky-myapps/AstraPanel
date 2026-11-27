import { api, qs, upload } from '../api.js';
import {
  $,
  confirmDialog,
  copyText,
  formatBytes,
  formatDate,
  html,
  icon,
  modal,
  openContextMenu,
  promptDialog,
  setHTML,
  tip,
  toast,
  toggle,
  withBusy,
} from '../ui.js';

const EXT = (name) => /\.([^.]+)$/.exec(name.toLowerCase())?.[1] || '';
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp']);
const VIDEO = new Set(['mp4', 'webm', 'ogv', 'mov', 'm4v']);
const AUDIO = new Set(['mp3', 'ogg', 'oga', 'wav', 'm4a', 'flac']);
const CODE = new Set(['js', 'mjs', 'cjs', 'ts', 'json', 'html', 'css', 'scss', 'jsx', 'tsx', 'vue', 'py', 'sh', 'yml', 'yaml', 'xml', 'php', 'sql']);
const isArchive = (name) => /\.(zip|tar|tar\.gz|tgz|tar\.xz|tar\.bz2)$/i.test(name);

function kindOf(entry) {
  if (entry.type === 'dir') return 'dir';
  const ext = EXT(entry.name);
  if (IMAGE.has(ext)) return 'image';
  if (VIDEO.has(ext)) return 'video';
  if (AUDIO.has(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (isArchive(entry.name)) return 'archive';
  if (CODE.has(ext)) return 'code';
  return 'file';
}

const KIND_ICON = { dir: 'folder', image: 'image', video: 'film', audio: 'music', pdf: 'fileText', archive: 'fileArchive', code: 'fileCode', file: 'file' };

const lastDir = new Map();

export function filesTab(el, page, app) {
  const base = `/apps/${app.id}/files`;
  const st = { cwd: lastDir.get(app.id) || '', entries: [], selected: new Set(), anchor: null, sort: { key: 'name', dir: 1 }, filter: '' };
  const join = (dir, name) => (dir ? `${dir}/${name}` : name);
  const rawUrl = (p) => `/api${base}/raw?${qs({ path: p })}`;
  const downloadUrl = (p) => `/api${base}/download?${qs({ path: p })}`;
  const zipUrl = (names) => `/api${base}/zip?${new URLSearchParams([['dir', st.cwd], ...names.map((n) => ['name', n])])}`;

  // ---- Données ---------------------------------------------------------------
  async function load(dir = st.cwd) {
    let data;
    try {
      data = await api.get(`${base}?${qs({ path: dir })}`);
    } catch (err) {
      if (dir) return load('');
      throw err;
    }
    if (!page.active) return;
    if (data.path !== st.cwd) {
      st.selected.clear();
      st.filter = '';
    }
    st.cwd = data.path;
    st.entries = data.entries;
    for (const name of [...st.selected]) if (!st.entries.some((e) => e.name === name)) st.selected.delete(name);
    lastDir.set(app.id, st.cwd);
    renderList();
  }

  function visible() {
    const f = st.filter.toLowerCase();
    const { key, dir } = st.sort;
    return st.entries
      .filter((e) => !f || e.name.toLowerCase().includes(f))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        const va = key === 'name' ? a.name.toLowerCase() : a[key];
        const vb = key === 'name' ? b.name.toLowerCase() : b[key];
        return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
      });
  }

  const selectedEntries = () => st.entries.filter((e) => st.selected.has(e.name));

  // ---- Liste -------------------------------------------------------------------
  function renderList() {
    const parts = st.cwd ? st.cwd.split('/') : [];
    setHTML(
      el,
      html`<div class="card fm" id="fm" tabindex="-1">
        <div class="fm-top">
          <div class="crumbs">
            <a data-dir="">${icon('folder')} ${app.id}</a>
            ${parts.map((p, i) => html`<span class="sep">/</span><a data-dir="${parts.slice(0, i + 1).join('/')}">${p}</a>`)}
          </div>
          <span class="spacer"></span>
          <label class="fm-search">${icon('search')}<input type="search" placeholder="Filtrer ce dossier…" value="${st.filter}" data-filter /></label>
        </div>
        <div class="fm-actions" id="fm-actions"></div>
        <div class="progress hidden" id="fm-progress"><i></i></div>
        <div class="fm-scroll">
          <table class="table fm-table">
            <thead>
              <tr>
                <th class="sel-col"><button type="button" class="sel" data-select-all aria-label="Tout sélectionner"></button></th>
                ${[['name', 'Nom'], ['size', 'Taille'], ['mtime', 'Modifié']].map(
                  ([key, label]) => html`<th class="${key === 'name' ? '' : 'hide-sm'}">
                    <button type="button" class="sort ${st.sort.key === key ? 'active' : ''}" data-sort="${key}">${label}${st.sort.key === key ? (st.sort.dir > 0 ? ' ↑' : ' ↓') : ''}</button>
                  </th>`,
                )}
                <th></th>
              </tr>
            </thead>
            <tbody id="fm-rows"></tbody>
          </table>
        </div>
        <div class="fm-status" id="fm-status"></div>
      </div>`,
    );
    renderRows();
  }

  function renderRows() {
    const rows = visible();
    const box = $('#fm-rows', el);
    if (!box) return;
    setHTML(
      box,
      html`${st.cwd ? html`<tr class="fm-up" data-up="${st.cwd.split('/').slice(0, -1).join('/')}"><td></td><td colspan="4"><span class="file-name dir">${icon('up')} ..</span></td></tr>` : ''}
        ${rows.length
          ? rows.map((e) => {
              const kind = kindOf(e);
              const sel = st.selected.has(e.name);
              return html`<tr class="fm-row ${sel ? 'selected' : ''}" data-name="${e.name}">
                <td class="sel-col"><button type="button" class="sel ${sel ? 'on' : ''}" data-toggle aria-label="Sélectionner ${e.name}" aria-pressed="${sel}"></button></td>
                <td>
                  <span class="file-name ${kind}">${icon(KIND_ICON[kind])}<span class="truncate">${e.name}</span></span>
                </td>
                <td class="muted hide-sm nowrap">${e.type === 'dir' ? '—' : formatBytes(e.size)}</td>
                <td class="muted hide-sm nowrap">${formatDate(e.mtime)}</td>
                <td>
                  <div class="file-actions">
                    <a class="btn btn-ghost btn-sm btn-icon" title="${e.type === 'dir' ? 'Télécharger (zip)' : 'Télécharger'}" href="${e.type === 'dir' ? zipUrl([e.name]) : downloadUrl(join(st.cwd, e.name))}">${icon('download')}</a>
                    <button class="btn btn-ghost btn-sm btn-icon" title="Renommer" data-row-act="rename">${icon('edit')}</button>
                    <button class="btn btn-ghost btn-sm btn-icon" title="Supprimer" data-row-act="delete">${icon('trash')}</button>
                  </div>
                </td>
              </tr>`;
            })
          : html`<tr><td></td><td colspan="4" class="muted fm-empty">${st.filter ? 'Aucun élément ne correspond au filtre.' : 'Dossier vide. Glissez-déposez des fichiers ou des dossiers ici.'}</td></tr>`}`,
    );
    const all = $('[data-select-all]', el);
    const allSelected = rows.length > 0 && rows.every((e) => st.selected.has(e.name));
    all.classList.toggle('on', allSelected);
    all.classList.toggle('partial', !allSelected && st.selected.size > 0);
    renderActions();
    renderStatus(rows);
  }

  function renderActions() {
    const box = $('#fm-actions', el);
    if (!box) return;
    const sel = selectedEntries();
    if (!sel.length) {
      setHTML(
        box,
        html`<button class="btn btn-sm" data-act="new-file">${icon('filePlus')} Nouveau fichier</button>
          <button class="btn btn-sm" data-act="new-dir">${icon('folderPlus')} Nouveau dossier</button>
          <label class="btn btn-sm">${icon('upload')} Téléverser<input type="file" multiple hidden data-upload /></label>
          <label class="btn btn-sm btn-ghost">${icon('folder')} Envoyer un dossier<input type="file" webkitdirectory multiple hidden data-upload /></label>
          <span class="spacer"></span>
          <button class="btn btn-sm btn-ghost btn-icon" data-act="refresh" title="Actualiser">${icon('refresh')}</button>`,
      );
      return;
    }
    const one = sel.length === 1 ? sel[0] : null;
    setHTML(
      box,
      html`<span class="sel-count">${sel.length} sélectionné${sel.length > 1 ? 's' : ''}</span>
        ${one ? html`<button class="btn btn-sm" data-act="open">${icon(one.type === 'dir' ? 'folder' : 'eye')} Ouvrir</button>` : ''}
        ${one ? html`<button class="btn btn-sm" data-act="rename">${icon('edit')} Renommer</button>` : ''}
        <button class="btn btn-sm" data-act="move">${icon('move')} Déplacer</button>
        <button class="btn btn-sm" data-act="copy">${icon('copy')} Copier</button>
        <button class="btn btn-sm" data-act="compress">${icon('fileArchive')} Compresser</button>
        ${one && isArchive(one.name) ? html`<button class="btn btn-sm" data-act="extract">${icon('archive')} Extraire</button>` : ''}
        <button class="btn btn-sm" data-act="download">${icon('download')} Télécharger</button>
        <button class="btn btn-sm btn-danger" data-act="delete">${icon('trash')} Supprimer</button>
        <span class="spacer"></span>
        <button class="btn btn-sm btn-ghost btn-icon" data-act="clear" title="Tout désélectionner">${icon('x')}</button>`,
    );
  }

  function renderStatus(rows) {
    const box = $('#fm-status', el);
    if (!box) return;
    const files = st.entries.filter((e) => e.type === 'file');
    const total = files.reduce((s, e) => s + e.size, 0);
    const sel = selectedEntries();
    const selSize = sel.filter((e) => e.type === 'file').reduce((s, e) => s + e.size, 0);
    box.textContent =
      `${rows.length} élément${rows.length > 1 ? 's' : ''}` +
      (st.filter ? ` (sur ${st.entries.length})` : '') +
      ` · ${formatBytes(total)} de fichiers` +
      (sel.length ? ` · ${sel.length} sélectionné${sel.length > 1 ? 's' : ''}${selSize ? ` (${formatBytes(selSize)})` : ''}` : '');
  }

  // ---- Ouverture ---------------------------------------------------------------
  async function open(entry) {
    const kind = kindOf(entry);
    const p = join(st.cwd, entry.name);
    if (kind === 'dir') return load(p);
    if (kind === 'image' || kind === 'video' || kind === 'audio') return viewer(entry);
    if (kind === 'pdf') return window.open(rawUrl(p), '_blank', 'noopener');
    if (kind === 'archive') {
      if (await confirmDialog('Extraire l’archive ?', `Le contenu de « ${entry.name} » sera extrait dans un nouveau dossier.`, { confirmLabel: 'Extraire' })) {
        await extract(entry);
      }
      return;
    }
    return editor(p);
  }

  async function extract(entry) {
    const { name } = await api.post(`${base}/extract`, { path: join(st.cwd, entry.name) });
    toast(`Archive extraite dans « ${name} »`);
    st.selected = new Set([name]);
    await load();
  }

  // Visionneuse plein écran pour images, vidéos et sons (flèches pour passer au suivant).
  function viewer(entry) {
    const media = visible().filter((e) => ['image', 'video', 'audio'].includes(kindOf(e)));
    let index = Math.max(0, media.findIndex((e) => e.name === entry.name));
    const overlay = document.createElement('div');
    overlay.className = 'viewer';
    document.body.appendChild(overlay);

    const draw = () => {
      const e = media[index];
      const kind = kindOf(e);
      const src = rawUrl(join(st.cwd, e.name));
      setHTML(
        overlay,
        html`<div class="viewer-top">
            <span class="truncate"><b>${e.name}</b> <span class="muted">· ${formatBytes(e.size)} · ${index + 1} / ${media.length}</span></span>
            <span class="spacer"></span>
            <a class="btn btn-ghost btn-sm" href="${downloadUrl(join(st.cwd, e.name))}">${icon('download')} <span class="hide-sm">Télécharger</span></a>
            <button class="btn btn-ghost btn-sm btn-icon" data-close title="Fermer (Échap)">${icon('x')}</button>
          </div>
          <div class="viewer-body">
            ${media.length > 1 ? html`<button class="viewer-nav prev" data-prev title="Précédent (←)">${icon('back')}</button>` : ''}
            ${kind === 'image'
              ? html`<img src="${src}" alt="${e.name}" />`
              : kind === 'video'
                ? html`<video src="${src}" controls autoplay playsinline></video>`
                : html`<div class="viewer-audio">${icon('music')}<audio src="${src}" controls autoplay></audio></div>`}
            ${media.length > 1 ? html`<button class="viewer-nav next" data-next title="Suivant (→)">${icon('chevronRight')}</button>` : ''}
          </div>`,
      );
    };
    const close = () => {
      overlay.querySelectorAll('video, audio').forEach((m) => m.pause());
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    };
    const go = (d) => {
      overlay.querySelectorAll('video, audio').forEach((m) => m.pause());
      index = (index + d + media.length) % media.length;
      draw();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft' && media.length > 1) go(-1);
      else if (e.key === 'ArrowRight' && media.length > 1) go(1);
    };
    overlay.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]') || e.target === overlay || e.target.classList.contains('viewer-body')) close();
      else if (e.target.closest('[data-prev]')) go(-1);
      else if (e.target.closest('[data-next]')) go(1);
    });
    document.addEventListener('keydown', onKey);
    page.onCleanup(close);
    draw();
  }

  // Éditeur de texte avec numéros de ligne.
  async function editor(p) {
    let file;
    try {
      file = await api.get(`${base}/content?${qs({ path: p })}`);
    } catch (err) {
      toast(err.message, 'err');
      return;
    }
    if (!page.active) return;
    let saved = file.content;
    setHTML(
      el,
      html`<div class="card">
        <div class="card-header editor-head">
          <button class="btn btn-ghost btn-sm" data-close>${icon('back')} Fichiers</button>
          <span class="mono truncate">${p}</span>
          <span class="badge plain hidden" id="dirty">modifié</span>
          <span class="spacer"></span>
          <label class="check inline hide-sm">${toggle('wrap', false, { sm: true, id: 'wrap' })}<span class="hint">Retour à la ligne</span></label>
          <a class="btn btn-ghost btn-sm btn-icon" title="Télécharger" href="${downloadUrl(p)}">${icon('download')}</a>
          <button class="btn btn-primary btn-sm" data-save>${icon('save')} Enregistrer</button>
        </div>
        <div class="editor-wrap">
          <pre class="gutter" aria-hidden="true"></pre>
          <textarea class="editor" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea>
        </div>
        <div class="fm-status"><span id="cursor-pos">Ligne 1, colonne 1</span> · ${formatBytes(file.size)} · Ctrl+S pour enregistrer</div>
      </div>`,
    );
    const area = $('textarea', el);
    const gutter = $('.gutter', el);
    const dirty = $('#dirty', el);
    const pos = $('#cursor-pos', el);
    area.value = file.content;
    let lineCount = 0;
    const updateGutter = () => {
      const n = area.value.split('\n').length;
      if (n !== lineCount) {
        lineCount = n;
        gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
      }
      gutter.scrollTop = area.scrollTop;
    };
    const updateCursor = () => {
      const before = area.value.slice(0, area.selectionStart).split('\n');
      pos.textContent = `Ligne ${before.length}, colonne ${before.at(-1).length + 1}`;
    };
    const markDirty = () => dirty.classList.toggle('hidden', area.value === saved);
    updateGutter();
    area.setSelectionRange(0, 0);
    area.focus();
    area.scrollTop = 0;

    const save = () =>
      withBusy($('[data-save]', el), async () => {
        await api.put(`${base}/content`, { path: p, content: area.value });
        saved = area.value;
        markDirty();
        toast('Fichier enregistré');
      });
    area.addEventListener('input', () => {
      markDirty();
      updateGutter();
    });
    area.addEventListener('scroll', () => (gutter.scrollTop = area.scrollTop));
    area.addEventListener('click', updateCursor);
    area.addEventListener('keyup', updateCursor);
    area.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        save();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end');
        markDirty();
      }
    });
    $('#wrap', el).addEventListener('change', (e) => {
      el.querySelector('.editor-wrap').classList.toggle('wrapped', e.target.checked);
    });
    $('[data-save]', el).addEventListener('click', save);
    $('[data-close]', el).addEventListener('click', async () => {
      if (area.value !== saved && !(await confirmDialog('Modifications non enregistrées', 'Quitter l’éditeur sans enregistrer ?', { confirmLabel: 'Quitter' }))) return;
      load();
    });
  }

  // ---- Actions -----------------------------------------------------------------
  async function askFolder(title, confirmLabel) {
    const result = await modal({
      title,
      confirmLabel,
      body: html`<div class="field">
        <label>Dossier de destination ${tip(html`Chemin depuis la racine de l'application, par exemple <code>public/images</code>. Laissez vide pour la racine. Le dossier est créé s'il n'existe pas.`)}</label>
        <input type="text" name="dest" class="mono" value="${st.cwd}" placeholder="(racine de l'application)" autocomplete="off" />
      </div>`,
    });
    return result ? result.dest.trim().replace(/^\/+|\/+$/g, '') : null;
  }

  async function action(act, button) {
    const sel = selectedEntries();
    const paths = sel.map((e) => join(st.cwd, e.name));
    switch (act) {
      case 'refresh':
        return load();
      case 'clear':
        st.selected.clear();
        return renderRows();
      case 'new-file': {
        const name = await promptDialog('Nouveau fichier', { label: 'Nom du fichier', placeholder: 'index.js', confirmLabel: 'Créer' });
        if (!name) return;
        await api.put(`${base}/content`, { path: join(st.cwd, name), content: '' });
        return editor(join(st.cwd, name));
      }
      case 'new-dir': {
        const name = await promptDialog('Nouveau dossier', { label: 'Nom du dossier', confirmLabel: 'Créer' });
        if (!name) return;
        await api.post(`${base}/mkdir`, { path: join(st.cwd, name) });
        st.selected = new Set([name]);
        return load();
      }
      case 'open':
        return open(sel[0]);
      case 'rename': {
        const entry = sel[0];
        const name = await promptDialog('Renommer', { label: 'Nouveau nom', value: entry.name, confirmLabel: 'Renommer' });
        if (!name || name === entry.name) return;
        await api.post(`${base}/rename`, { from: join(st.cwd, entry.name), to: join(st.cwd, name) });
        st.selected = new Set([name]);
        return load();
      }
      case 'move':
      case 'copy': {
        const dest = await askFolder(act === 'move' ? `Déplacer ${sel.length} élément(s)` : `Copier ${sel.length} élément(s)`, act === 'move' ? 'Déplacer' : 'Copier');
        if (dest === null) return;
        await withBusy(button, () => api.post(`${base}/${act}`, { paths, dest }));
        toast(act === 'move' ? 'Éléments déplacés' : 'Éléments copiés');
        st.selected.clear();
        return load();
      }
      case 'compress': {
        const name = await promptDialog('Compresser en ZIP', {
          label: 'Nom de l’archive',
          value: sel.length === 1 ? `${sel[0].name}.zip` : 'archive.zip',
          confirmLabel: 'Compresser',
        });
        if (!name) return;
        toast('Compression en cours…', 'info');
        const result = await withBusy(button, () => api.post(`${base}/compress`, { dir: st.cwd, names: sel.map((e) => e.name), archive: name }));
        if (!result) return;
        toast(`Archive « ${result.name} » créée`);
        st.selected = new Set([result.name]);
        return load();
      }
      case 'extract':
        return withBusy(button, () => extract(sel[0]));
      case 'download':
        window.location.href = sel.length === 1 && sel[0].type === 'file' ? downloadUrl(paths[0]) : zipUrl(sel.map((e) => e.name));
        return undefined;
      case 'delete': {
        const label = sel.length === 1 ? `« ${sel[0].name} »` : `${sel.length} éléments`;
        if (!(await confirmDialog('Supprimer ?', `${label} sera supprimé définitivement.`, { danger: true, confirmLabel: 'Supprimer' }))) return;
        await withBusy(button, () => api.post(`${base}/delete`, { paths }));
        toast('Supprimé');
        st.selected.clear();
        return load();
      }
      default:
        return undefined;
    }
  }

  // Sélection : clic = un seul élément, Ctrl/Cmd = ajouter, Maj = plage ; le rond à gauche coche/décoche.
  function select(name, e, forceToggle = false) {
    const rows = visible().map((x) => x.name);
    if (e.shiftKey && st.anchor && rows.includes(st.anchor)) {
      const [a, b] = [rows.indexOf(st.anchor), rows.indexOf(name)].sort((x, y) => x - y);
      if (!(e.ctrlKey || e.metaKey)) st.selected.clear();
      rows.slice(a, b + 1).forEach((n) => st.selected.add(n));
    } else if (forceToggle || e.ctrlKey || e.metaKey) {
      if (st.selected.has(name)) st.selected.delete(name);
      else st.selected.add(name);
      st.anchor = name;
    } else {
      st.selected = new Set([name]);
      st.anchor = name;
    }
    renderRows();
  }

  // Double-clic (ou double toucher sur téléphone) : deux clics rapides sur la même ligne
  let lastClick = null;
  const isDouble = (key, e) => {
    const now = Date.now();
    const double = !e.shiftKey && !e.ctrlKey && !e.metaKey && lastClick?.key === key && now - lastClick.t < 450;
    lastClick = double ? null : { key, t: now };
    return double;
  };

  // ---- Propriétés ------------------------------------------------------------------
  const MODE = (m) =>
    [...m]
      .map((d) => {
        const n = Number(d);
        return `${n & 4 ? 'r' : '-'}${n & 2 ? 'w' : '-'}${n & 1 ? 'x' : '-'}`;
      })
      .join('');
  async function properties(entries) {
    const paths = entries.length ? entries.map((e) => join(st.cwd, e.name)) : [st.cwd];
    const infos = await Promise.all(paths.slice(0, 50).map((p) => api.get(`${base}/stat?${qs({ path: p })}`)));
    const row = (label, value) => html`<tr><td class="muted">${label}</td><td>${value}</td></tr>`;
    let body;
    if (infos.length === 1) {
      const i = infos[0];
      const kindLabel = i.type === 'dir' ? 'Dossier' : { image: 'Image', video: 'Vidéo', audio: 'Son', pdf: 'Document PDF', archive: 'Archive', code: 'Code source', file: 'Fichier' }[kindOf(i)];
      body = html`<div class="props-head">${icon(i.type === 'dir' ? 'folder' : KIND_ICON[kindOf(i)])}<b>${i.name || app.name}</b></div>
        <table class="table kv-table compact props"><tbody>
          ${row('Type', `${kindLabel}${i.link ? ' (lien symbolique)' : ''}`)}
          ${row('Emplacement', html`<span class="mono">/${i.path}</span>`)}
          ${row('Taille', i.type === 'dir' ? `${formatBytes(i.size)}${i.partial ? ' (au moins)' : ''}` : `${formatBytes(i.size)} (${i.size.toLocaleString('fr-FR')} octets)`)}
          ${i.type === 'dir' ? row('Contenu', `${i.files.toLocaleString('fr-FR')} fichier${i.files > 1 ? 's' : ''}, ${i.dirs.toLocaleString('fr-FR')} dossier${i.dirs > 1 ? 's' : ''}${i.partial ? ' (au moins)' : ''}`) : ''}
          ${row('Modifié', formatDate(i.mtime))}
          ${row('Créé', formatDate(i.ctime))}
          ${row('Permissions', html`<span class="mono">${MODE(i.mode)}</span> <span class="muted">(${i.mode})</span>`)}
          ${row('Chemin complet', html`<span class="mono props-path">${app.dir}/${i.path}</span>`)}
        </tbody></table>`;
    } else {
      const files = infos.reduce((n, i) => n + (i.type === 'dir' ? i.files : 1), 0);
      const dirs = infos.reduce((n, i) => n + (i.type === 'dir' ? 1 + i.dirs : 0), 0);
      const size = infos.reduce((n, i) => n + i.size, 0);
      body = html`<div class="props-head">${icon('copy')}<b>${entries.length} éléments</b></div>
        <table class="table kv-table compact props"><tbody>
          ${row('Emplacement', html`<span class="mono">/${st.cwd}</span>`)}
          ${row('Taille totale', formatBytes(size))}
          ${row('Contenu', `${files.toLocaleString('fr-FR')} fichier${files > 1 ? 's' : ''}, ${dirs.toLocaleString('fr-FR')} dossier${dirs > 1 ? 's' : ''}`)}
          ${row('Éléments', entries.map((e) => e.name).join(', '))}
        </tbody></table>`;
    }
    await modal({ title: 'Propriétés', body, confirmLabel: 'Fermer', cancelLabel: '', cls: 'props-modal' });
  }

  // ---- Menu clic droit ---------------------------------------------------------------
  const PREVIEW = new Set(['image', 'video', 'audio', 'pdf']);
  function fileMenu(sel) {
    const one = sel.length === 1 ? sel[0] : null;
    const kind = one && kindOf(one);
    const run = (act) => () => action(act);
    return [
      one && { label: one.type === 'dir' ? 'Ouvrir le dossier' : 'Ouvrir', icon: one.type === 'dir' ? 'folder' : 'eye', hint: 'Entrée', onClick: () => open(one) },
      one && PREVIEW.has(kind) && { label: 'Ouvrir dans un nouvel onglet', icon: 'external', onClick: () => window.open(rawUrl(join(st.cwd, one.name)), '_blank', 'noopener') },
      '-',
      one && { label: 'Renommer', icon: 'edit', hint: 'F2', onClick: run('rename') },
      { label: 'Copier vers…', icon: 'copy', onClick: run('copy') },
      { label: 'Déplacer vers…', icon: 'move', onClick: run('move') },
      '-',
      { label: one ? 'Compresser en ZIP' : `Compresser les ${sel.length} éléments en ZIP`, icon: 'fileArchive', onClick: run('compress') },
      one && kind === 'archive' && { label: 'Extraire ici', icon: 'archive', onClick: run('extract') },
      { label: one && one.type === 'file' ? 'Télécharger' : 'Télécharger (ZIP)', icon: 'download', onClick: run('download') },
      one && { label: 'Copier le chemin', icon: 'link', onClick: async () => { await copyText(`${app.dir}/${join(st.cwd, one.name)}`); toast('Chemin copié'); } },
      '-',
      { label: one ? 'Supprimer' : `Supprimer les ${sel.length} éléments`, icon: 'trash', hint: 'Suppr', danger: true, onClick: run('delete') },
      '-',
      { label: 'Propriétés', icon: 'info', hint: 'Alt+Entrée', onClick: () => properties(sel) },
    ];
  }
  function folderMenu() {
    return [
      { label: 'Nouveau fichier', icon: 'filePlus', onClick: () => action('new-file') },
      { label: 'Nouveau dossier', icon: 'folderPlus', onClick: () => action('new-dir') },
      { label: 'Téléverser des fichiers…', icon: 'upload', onClick: () => el.querySelector('input[data-upload]:not([webkitdirectory])')?.click() },
      { label: 'Téléverser un dossier…', icon: 'folder', onClick: () => el.querySelector('input[data-upload][webkitdirectory]')?.click() },
      '-',
      st.cwd && { label: 'Dossier parent', icon: 'up', onClick: () => load(st.cwd.split('/').slice(0, -1).join('/')) },
      { label: 'Tout sélectionner', icon: 'check', hint: 'Ctrl+A', onClick: () => { st.selected = new Set(visible().map((x) => x.name)); renderRows(); } },
      { label: 'Actualiser', icon: 'refresh', onClick: () => load() },
      '-',
      { label: 'Propriétés du dossier', icon: 'info', onClick: () => properties([]) },
    ];
  }

  // ---- Téléversement (fichiers, dossiers, glisser-déposer) --------------------
  async function uploadAll(items) {
    if (!items.length) return;
    const bar = $('#fm-progress', el);
    bar?.classList.remove('hidden');
    const totalBytes = items.reduce((s, it) => s + it.file.size, 0) || 1;
    let doneBytes = 0;
    let failed = 0;
    for (const { file, dir } of items) {
      try {
        await upload(`${base}/upload?${qs({ path: join(st.cwd, dir), name: file.name })}`, file, (r) => {
          if (bar) bar.firstElementChild.style.width = `${(((doneBytes + r * file.size) / totalBytes) * 100).toFixed(0)}%`;
        });
      } catch (err) {
        failed++;
        toast(`${file.name} : ${err.message}`, 'err');
      }
      doneBytes += file.size;
    }
    if (items.length - failed) toast(`${items.length - failed} fichier(s) téléversé(s)`);
    return load();
  }

  const fromInput = (files) =>
    [...files].map((file) => ({ file, dir: (file.webkitRelativePath || '').split('/').slice(0, -1).join('/') }));

  async function fromDrop(dataTransfer) {
    const entries = [...dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    if (!entries.length) return fromInput(dataTransfer.files);
    const out = [];
    const walk = async (entry, dir) => {
      if (entry.isFile) {
        out.push({ file: await new Promise((res, rej) => entry.file(res, rej)), dir });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const sub = join(dir, entry.name);
        for (;;) {
          const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          if (!batch.length) break;
          for (const child of batch) await walk(child, sub);
        }
      }
    };
    for (const entry of entries) await walk(entry, '');
    return out;
  }

  // ---- Écouteurs -----------------------------------------------------------------
  el.addEventListener('click', async (e) => {
    if (!$('#fm', el)) return;
    const target = e.target;
    try {
      const dirLink = target.closest('[data-dir]');
      if (dirLink) return await load(dirLink.dataset.dir);
      if (target.closest('[data-select-all]')) {
        const rows = visible();
        const all = rows.length && rows.every((x) => st.selected.has(x.name));
        st.selected = all ? new Set() : new Set(rows.map((x) => x.name));
        return renderRows();
      }
      const sort = target.closest('[data-sort]');
      if (sort) {
        const key = sort.dataset.sort;
        st.sort = { key, dir: st.sort.key === key ? -st.sort.dir : key === 'name' ? 1 : -1 };
        return renderList();
      }
      const act = target.closest('[data-act]');
      if (act) return await action(act.dataset.act, act);
      const up = target.closest('[data-up]');
      if (up) return isDouble('..', e) ? await load(up.dataset.up) : undefined;
      const row = target.closest('.fm-row');
      if (!row) {
        // clic dans le vide de la liste : on désélectionne
        if (target.closest('.fm-scroll') && st.selected.size) {
          st.selected.clear();
          renderRows();
        }
        return undefined;
      }
      const entry = st.entries.find((x) => x.name === row.dataset.name);
      if (target.closest('[data-toggle]')) return select(entry.name, e, true);
      const rowAct = target.closest('[data-row-act]');
      if (rowAct) {
        st.selected = new Set([entry.name]);
        renderRows();
        return await action(rowAct.dataset.rowAct, rowAct);
      }
      if (target.closest('a')) return undefined;
      // un clic sélectionne, un double-clic ouvre
      if (isDouble(entry.name, e)) return await open(entry);
      return select(entry.name, e);
    } catch (err) {
      toast(err.message, 'err');
    }
    return undefined;
  });

  // Menu clic droit : sur un élément (ou la sélection), ou dans le vide du dossier
  el.addEventListener('contextmenu', (e) => {
    if (!$('#fm', el) || e.shiftKey || e.target.closest('input, textarea') || !e.target.closest('#fm')) return;
    e.preventDefault();
    const row = e.target.closest('.fm-row');
    if (row) {
      if (!st.selected.has(row.dataset.name)) {
        st.selected = new Set([row.dataset.name]);
        st.anchor = row.dataset.name;
        renderRows();
      }
      openContextMenu(e.clientX, e.clientY, fileMenu(selectedEntries()));
    } else {
      openContextMenu(e.clientX, e.clientY, folderMenu());
    }
  });

  el.addEventListener('input', (e) => {
    if (!e.target.matches('[data-filter]')) return;
    st.filter = e.target.value;
    renderRows();
  });

  el.addEventListener('change', (e) => {
    if (e.target.matches('[data-upload]') && e.target.files.length) uploadAll(fromInput(e.target.files));
  });

  el.addEventListener('keydown', (e) => {
    if (!$('#fm', el) || e.target.matches('input, textarea')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      st.selected = new Set(visible().map((x) => x.name));
      renderRows();
    } else if (e.key === 'Delete' && st.selected.size) {
      action('delete').catch((err) => toast(err.message, 'err'));
    } else if (e.key === 'Enter' && e.altKey && st.selected.size) {
      properties(selectedEntries()).catch((err) => toast(err.message, 'err'));
    } else if (e.key === 'Enter' && st.selected.size === 1) {
      open(selectedEntries()[0]).catch((err) => toast(err.message, 'err'));
    } else if (e.key === 'F2' && st.selected.size === 1) {
      action('rename').catch((err) => toast(err.message, 'err'));
    } else if (e.key === 'Escape' && st.selected.size) {
      st.selected.clear();
      renderRows();
    }
  });

  el.addEventListener('dragover', (e) => {
    if (!$('#fm', el) || !e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    $('#fm', el).classList.add('drop-hint');
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) $('#fm', el)?.classList.remove('drop-hint');
  });
  el.addEventListener('drop', async (e) => {
    if (!$('#fm', el)) return;
    e.preventDefault();
    $('#fm', el).classList.remove('drop-hint');
    try {
      await uploadAll(await fromDrop(e.dataTransfer));
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  load().catch((err) => setHTML(el, html`<div class="alert err">${icon('alert')}<div>${err.message}</div></div>`));
}


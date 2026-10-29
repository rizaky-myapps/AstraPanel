import { api, qs, upload } from '../api.js';
import { findApp, onAppsChange, refreshApps } from '../state.js';
import { envEditor } from '../env-editor.js';
import {
  $,
  TYPE_INFO,
  confirmDialog,
  copyText,
  domainUrl,
  formatBytes,
  formatDate,
  formatDuration,
  formatPercent,
  formatTime,
  html,
  icon,
  localUrl,
  modal,
  promptDialog,
  setHTML,
  statusBadge,
  toast,
  withBusy,
} from '../ui.js';

const TABS = [
  { id: 'console', label: 'Console', icon: 'terminal' },
  { id: 'files', label: 'Fichiers', icon: 'folder' },
  { id: 'env', label: 'Variables', icon: 'key' },
  { id: 'deploy', label: 'Déploiement', icon: 'upload' },
  { id: 'settings', label: 'Paramètres', icon: 'sliders' },
];

export function renderApp(view, page, id, tab = 'console') {
  const app = findApp(id);
  if (!app) {
    setHTML(
      view,
      html`<div class="card empty"><h2>Application introuvable</h2><p>Elle a peut-être été supprimée.</p><a class="btn" href="#/">Retour au tableau de bord</a></div>`,
    );
    return;
  }
  if (!TABS.some((t) => t.id === tab)) tab = 'console';

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

  const renderers = { console: consoleTab, files: filesTab, env: envTab, deploy: deployTab, settings: settingsTab };
  renderers[tab]($('#tab', root), page, app);
}

function renderHeader(el, app) {
  const type = TYPE_INFO[app.type];
  const rt = app.runtime;
  const running = rt.status === 'running';
  const active = running || rt.status === 'restarting' || rt.status === 'stopping';
  const busy = Boolean(rt.busy);
  const details = [type.label];
  if (app.port) details.push(`port ${app.port}`);
  if (running) {
    details.push(`PID ${rt.pid}`, `depuis ${formatDuration(Date.now() - rt.startedAt)}`);
    details.push(`CPU ${formatPercent(rt.cpu)}`, `RAM ${formatBytes(rt.memory)}`);
  } else if (rt.lastExit) {
    details.push(`dernier arrêt ${formatDate(rt.lastExit.at)}`);
  }
  const url = localUrl(app);

  setHTML(
    el,
    html`<div class="page-header">
      <div class="title">
        <div class="app-icon lg ${app.type}">${icon(type.icon)}</div>
        <div class="truncate">
          <div class="row"><h1 class="truncate">${app.name}</h1>${statusBadge(app)}</div>
          <div class="sub">${details.join(' · ')}</div>
        </div>
      </div>
      <span class="spacer"></span>
      <div class="row">
        ${app.domains.map((d) => html`<a class="btn btn-ghost btn-sm" href="${domainUrl(d)}" target="_blank" rel="noopener">${icon('globe')} ${d}</a>`)}
        ${url ? html`<a class="btn btn-ghost btn-sm" href="${url}" target="_blank" rel="noopener">${icon('external')} Ouvrir</a>` : ''}
        ${active
          ? html`<button class="btn" data-action="stop" ${busy ? 'disabled' : ''}>${icon('stop')} Arrêter</button>`
          : html`<button class="btn btn-success" data-action="start" ${busy ? 'disabled' : ''}>${icon('play')} Démarrer</button>`}
        <button class="btn" data-action="restart" ${busy ? 'disabled' : ''}>${icon('restart')} Redémarrer</button>
        ${active ? html`<button class="btn btn-ghost btn-icon" data-action="kill" title="Forcer l'arrêt">${icon('zap')}</button>` : ''}
      </div>
    </div>`,
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
        <label class="check" style="margin:0"><input type="checkbox" id="autoscroll" checked /><span class="hint">Défilement auto</span></label>
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

  const showEmpty = () => {
    out.textContent = '';
    const div = document.createElement('div');
    div.className = 'console-empty';
    div.textContent = 'Aucune sortie pour le moment. Démarrez l’application pour voir ses logs ici.';
    out.appendChild(div);
  };

  const append = (lines) => {
    out.querySelector('.console-empty')?.remove();
    const frag = document.createDocumentFragment();
    for (const line of lines) {
      const row = document.createElement('div');
      row.className = `l ${line.s}`;
      const ts = document.createElement('span');
      ts.className = 'ts';
      ts.textContent = line.t ? formatTime(line.t) : '';
      const msg = document.createElement('span');
      msg.className = 'm';
      msg.textContent = line.m;
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

// ---- Fichiers ----------------------------------------------------------------
const lastDir = new Map();

function filesTab(el, page, app) {
  let cwd = lastDir.get(app.id) || '';
  const join = (dir, name) => (dir ? `${dir}/${name}` : name);

  async function showList(dir = cwd) {
    let data;
    try {
      data = await api.get(`/apps/${app.id}/files?${qs({ path: dir })}`);
    } catch (err) {
      if (dir) return showList('');
      throw err;
    }
    if (!page.active) return;
    cwd = data.path;
    lastDir.set(app.id, cwd);
    const parts = cwd ? cwd.split('/') : [];
    setHTML(
      el,
      html`<div class="card" id="drop">
        <div class="card-header">
          <div class="crumbs">
            <a data-dir="">${icon('folder')} ${app.id}</a>
            ${parts.map((p, i) => html`<span class="sep">/</span><a data-dir="${parts.slice(0, i + 1).join('/')}">${p}</a>`)}
          </div>
          <span class="spacer"></span>
          <button class="btn btn-ghost btn-sm" data-new-file title="Nouveau fichier">${icon('filePlus')} <span class="hide-sm">Fichier</span></button>
          <button class="btn btn-ghost btn-sm" data-new-dir title="Nouveau dossier">${icon('folderPlus')} <span class="hide-sm">Dossier</span></button>
          <label class="btn btn-sm" title="Téléverser">${icon('upload')} <span class="hide-sm">Téléverser</span><input type="file" multiple hidden data-upload /></label>
        </div>
        <div class="progress hidden" id="upload-progress"><i></i></div>
        <div style="overflow-x:auto">
          <table class="table">
            <thead><tr><th>Nom</th><th class="hide-sm">Taille</th><th class="hide-sm">Modifié</th><th></th></tr></thead>
            <tbody>
              ${cwd ? html`<tr><td colspan="4"><a class="file-name dir" data-dir="${parts.slice(0, -1).join('/')}">${icon('up')} ..</a></td></tr>` : ''}
              ${data.entries.length || cwd ? '' : html`<tr><td colspan="4" class="muted">Dossier vide. Glissez-déposez des fichiers ici ou utilisez « Téléverser ».</td></tr>`}
              ${data.entries.map(
                (f) => html`<tr>
                  <td>
                    <a class="file-name ${f.type}" ${f.type === 'dir' ? html`data-dir="${join(cwd, f.name)}"` : html`data-open="${join(cwd, f.name)}"`}>
                      ${icon(f.type === 'dir' ? 'folder' : 'file')}<span class="truncate">${f.name}</span>
                    </a>
                  </td>
                  <td class="muted hide-sm nowrap">${f.type === 'dir' ? '—' : formatBytes(f.size)}</td>
                  <td class="muted hide-sm nowrap">${formatDate(f.mtime)}</td>
                  <td>
                    <div class="file-actions">
                      ${f.type === 'file'
                        ? html`<a class="btn btn-ghost btn-sm btn-icon" title="Télécharger" href="/api/apps/${app.id}/files/download?${qs({ path: join(cwd, f.name) })}">${icon('download')}</a>`
                        : ''}
                      <button class="btn btn-ghost btn-sm btn-icon" title="Renommer" data-rename="${f.name}">${icon('edit')}</button>
                      <button class="btn btn-ghost btn-sm btn-icon" title="Supprimer" data-delete="${f.name}">${icon('trash')}</button>
                    </div>
                  </td>
                </tr>`,
              )}
            </tbody>
          </table>
        </div>
      </div>`,
    );
  }

  async function showEditor(path) {
    let file;
    try {
      file = await api.get(`/apps/${app.id}/files/content?${qs({ path })}`);
    } catch (err) {
      toast(err.message, 'err');
      return;
    }
    if (!page.active) return;
    let saved = file.content;
    setHTML(
      el,
      html`<div class="card">
        <div class="card-header">
          <button class="btn btn-ghost btn-sm" data-close>${icon('back')} Fichiers</button>
          <span class="mono truncate">${path}</span>
          <span class="badge plain hidden" id="dirty">modifié</span>
          <span class="spacer"></span>
          <span class="hint hide-sm">Ctrl+S pour enregistrer</span>
          <button class="btn btn-primary btn-sm" data-save>${icon('save')} Enregistrer</button>
        </div>
        <textarea class="editor" spellcheck="false"></textarea>
      </div>`,
    );
    const area = $('textarea', el);
    const dirty = $('#dirty', el);
    area.value = file.content;
    area.setSelectionRange(0, 0);
    area.focus();
    area.scrollTop = 0;
    const markDirty = () => dirty.classList.toggle('hidden', area.value === saved);
    const save = () =>
      withBusy($('[data-save]', el), async () => {
        await api.put(`/apps/${app.id}/files/content`, { path, content: area.value });
        saved = area.value;
        markDirty();
        toast('Fichier enregistré');
      });
    area.addEventListener('input', markDirty);
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
    $('[data-save]', el).addEventListener('click', save);
    $('[data-close]', el).addEventListener('click', async () => {
      if (area.value !== saved && !(await confirmDialog('Modifications non enregistrées', 'Quitter l’éditeur sans enregistrer ?', { confirmLabel: 'Quitter' }))) return;
      showList();
    });
  }

  async function uploadFiles(files) {
    const bar = $('#upload-progress', el);
    bar?.classList.remove('hidden');
    for (const [i, file] of [...files].entries()) {
      try {
        await upload(`/apps/${app.id}/files/upload?${qs({ path: cwd, name: file.name })}`, file, (r) => {
          if (bar) bar.firstElementChild.style.width = `${(((i + r) / files.length) * 100).toFixed(0)}%`;
        });
      } catch (err) {
        toast(`${file.name} : ${err.message}`, 'err');
      }
    }
    toast(files.length > 1 ? `${files.length} fichiers téléversés` : 'Fichier téléversé');
    showList();
  }

  el.addEventListener('click', async (e) => {
    const target = e.target.closest('[data-dir], [data-open], [data-rename], [data-delete], [data-new-file], [data-new-dir]');
    if (!target) return;
    const d = target.dataset;
    try {
      if ('dir' in d) {
        await showList(d.dir);
      } else if ('open' in d) {
        await showEditor(d.open);
      } else if ('newFile' in d) {
        const name = await promptDialog('Nouveau fichier', { label: 'Nom du fichier', placeholder: 'index.js', confirmLabel: 'Créer' });
        if (!name) return;
        await api.put(`/apps/${app.id}/files/content`, { path: join(cwd, name), content: '' });
        await showEditor(join(cwd, name));
      } else if ('newDir' in d) {
        const name = await promptDialog('Nouveau dossier', { label: 'Nom du dossier', confirmLabel: 'Créer' });
        if (!name) return;
        await api.post(`/apps/${app.id}/files/mkdir`, { path: join(cwd, name) });
        await showList();
      } else if ('rename' in d) {
        const name = await promptDialog('Renommer', { label: 'Nouveau nom', value: d.rename, confirmLabel: 'Renommer' });
        if (!name || name === d.rename) return;
        await api.post(`/apps/${app.id}/files/rename`, { from: join(cwd, d.rename), to: join(cwd, name) });
        await showList();
      } else if ('delete' in d) {
        const ok = await confirmDialog('Supprimer ?', `« ${d.delete} » sera supprimé définitivement.`, { danger: true, confirmLabel: 'Supprimer' });
        if (!ok) return;
        await api.del(`/apps/${app.id}/files?${qs({ path: join(cwd, d.delete) })}`);
        await showList();
      }
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  el.addEventListener('change', (e) => {
    if (e.target.matches('[data-upload]') && e.target.files.length) uploadFiles(e.target.files);
  });
  el.addEventListener('dragover', (e) => {
    if (!$('#drop', el)) return;
    e.preventDefault();
    $('#drop', el).classList.add('drop-hint');
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) $('#drop', el)?.classList.remove('drop-hint');
  });
  el.addEventListener('drop', (e) => {
    if (!$('#drop', el)) return;
    e.preventDefault();
    $('#drop', el).classList.remove('drop-hint');
    if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  });

  showList().catch((err) => setHTML(el, html`<div class="alert err">${icon('alert')}<div>${err.message}</div></div>`));
}

// ---- Variables -----------------------------------------------------------------
function envTab(el, page, app) {
  setHTML(
    el,
    html`<div class="card">
      <div class="card-header"><h2>Variables d'environnement</h2></div>
      <div class="card-body">
        ${app.type === 'bot'
          ? html`<div class="alert info">${icon('info')}<div>Mettez ici le token de votre bot (<code>DISCORD_TOKEN</code>) plutôt que dans le code : il ne sera jamais publié sur Git.</div></div>`
          : html`<div class="alert info">${icon('info')}<div><code>PORT</code> est fourni automatiquement (${app.port}) : votre serveur doit écouter dessus.</div></div>`}
        <div id="env-editor"></div>
      </div>
      <div class="card-foot">
        <button class="btn" data-save="0">${icon('save')} Enregistrer</button>
        <button class="btn btn-primary" data-save="1">${icon('restart')} Enregistrer et redémarrer</button>
      </div>
    </div>`,
  );
  const editor = envEditor($('#env-editor', el), app.env);
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

// ---- Déploiement -------------------------------------------------------------
function deployTab(el, page, app) {
  const hookUrl = (token) => `${location.origin}/hooks/deploy/${app.id}/${token}`;
  setHTML(
    el,
    html`<div class="stack">
      <div class="card">
        <div class="card-header"><h2>Mettre à jour</h2></div>
        <div class="card-body">
          <p class="muted">
            Le déploiement ${app.git ? html`récupère la dernière version du dépôt Git, ` : ''}installe les dépendances
            (<code>${app.installCommand || 'désactivé'}</code>)${app.buildCommand ? html`, lance <code>${app.buildCommand}</code>` : ''}
            puis redémarre l'application si elle tournait.
          </p>
          <div class="row">
            <button class="btn btn-primary" data-task="deploy">${icon('upload')} Déployer maintenant</button>
            <button class="btn" data-task="install">${icon('package')} Installer les dépendances</button>
            ${app.buildCommand ? html`<button class="btn" data-task="build">${icon('wrench')} Lancer le build</button>` : ''}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><h2>${icon('git')} Dépôt Git</h2></div>
        <form class="card-body form-grid" id="git-form">
          <div class="field">
            <label>URL du dépôt</label>
            <input type="text" name="url" class="mono" value="${app.git?.url || ''}" placeholder="https://github.com/moi/projet.git" spellcheck="false" />
            <span class="hint">Privé : <code>https://&lt;jeton&gt;@github.com/moi/projet.git</code> ou une clé SSH de déploiement.</span>
          </div>
          <div class="field">
            <label>Branche</label>
            <input type="text" name="branch" class="mono" value="${app.git?.branch || ''}" placeholder="par défaut" spellcheck="false" />
          </div>
          <div class="full row">
            <span class="hint">Attention : un déploiement Git écrase les fichiers suivis par Git modifiés sur le Pi (vos fichiers .env, node_modules… sont conservés).</span>
            <span class="spacer"></span>
            <button class="btn" type="submit">${icon('save')} Enregistrer</button>
          </div>
        </form>
      </div>

      <div class="card">
        <div class="card-header"><h2>${icon('archive')} Importer une archive</h2></div>
        <form class="card-body" id="archive-form">
          <div class="field">
            <input type="file" name="file" accept=".zip,.tar,.tar.gz,.tgz" />
            <span class="hint">Le contenu est copié dans le dossier de l'application. Un ZIP téléchargé depuis GitHub fonctionne tel quel.</span>
          </div>
          <label class="check"><input type="checkbox" name="clean" /><span>Vider le dossier avant l'import<small>Supprime tous les fichiers actuels (y compris .env et node_modules).</small></span></label>
          <label class="check"><input type="checkbox" name="deploy" checked /><span>Déployer ensuite<small>Installe les dépendances, build et redémarre.</small></span></label>
          <div class="progress hidden"><i></i></div>
          <div class="row"><span class="spacer"></span><button class="btn" type="submit">${icon('upload')} Importer</button></div>
        </form>
      </div>

      ${app.git
        ? html`<div class="card">
            <div class="card-header"><h2>${icon('link')} Déploiement automatique (webhook)</h2></div>
            <div class="card-body">
              <p class="muted">À chaque <code>git push</code>, GitHub (ou GitLab, Gitea…) appelle cette adresse et le panel redéploie l'application.</p>
              <div class="input-group" style="margin-bottom:12px">
                <input type="text" class="mono" readonly value="${hookUrl(app.webhookToken)}" id="hook-url" />
                <button class="btn" data-copy-hook>${icon('copy')} Copier</button>
                <button class="btn btn-ghost" data-regen-hook title="Générer une nouvelle adresse">${icon('refresh')}</button>
              </div>
              <p class="hint">
                GitHub : dépôt → Settings → Webhooks → Add webhook. Payload URL = l'adresse ci-dessus, Content type =
                <code>application/json</code>, événement « Just the push event ». Le panel doit être joignable depuis Internet
                (domaine configuré dans les Paramètres ou tunnel Cloudflare).
              </p>
            </div>
          </div>`
        : ''}
    </div>`,
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
        <div class="card-header"><h2>Configuration</h2></div>
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
                  <label class="check"><input type="checkbox" name="spa" ${app.spa ? 'checked' : ''} /><span>Application monopage (SPA)</span></label>
                </div>`
            : ''}
          ${hasPort
            ? html`<div class="field">
                  <label>Port</label>
                  <input type="number" name="port" value="${app.port || ''}" min="1024" max="65535" />
                </div>
                <div class="field">
                  <label>Nom(s) de domaine</label>
                  <input type="text" name="domains" class="mono" value="${app.domains.join(', ')}" placeholder="monsite.fr, www.monsite.fr" spellcheck="false" />
                  <span class="hint">Préfixez par <code>http://</code> pour un domaine local sans HTTPS.</span>
                </div>`
            : ''}
          <div class="full">
            <label class="check"><input type="checkbox" name="autoRestart" ${app.autoRestart ? 'checked' : ''} /><span>Redémarrage automatique en cas de plantage</span></label>
          </div>
          <div class="full hint">Dossier sur le Raspberry Pi : <code>${app.dir}</code></div>
        </div>
        <div class="card-foot">
          <span class="hint">Les changements de commande ou de port s'appliquent au prochain redémarrage.</span>
          <span class="spacer"></span>
          <button class="btn btn-primary" type="submit">${icon('save')} Enregistrer</button>
        </div>
      </form>

      <div class="card">
        <div class="card-header"><h2>Zone dangereuse</h2></div>
        <div class="card-body row">
          <div>
            <div class="label">Supprimer l'application</div>
            <div class="hint">Arrête l'application et supprime définitivement ses fichiers et ses journaux.</div>
          </div>
          <span class="spacer"></span>
          <button class="btn btn-danger" data-delete>${icon('trash')} Supprimer</button>
        </div>
      </div>
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
    };
    if (!isStatic) body.startCommand = values.startCommand;
    if (isStatic) Object.assign(body, { staticDir: values.staticDir, spa: form.spa.checked });
    if (hasPort) Object.assign(body, { port: values.port || null, domains: values.domains });
    withBusy($('[type=submit]', form), async () => {
      const { caddy } = await api.patch(`/apps/${app.id}`, body);
      if (caddy && !caddy.ok) toast(`Enregistré, mais Caddy a refusé la configuration : ${caddy.error}`, 'err');
      else toast('Paramètres enregistrés');
      await refreshApps();
    });
  });

  $('[data-delete]', el).addEventListener('click', async () => {
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

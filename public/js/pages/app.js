import { api, qs, upload } from '../api.js';
import { findApp, isAdmin, onAppsChange, refreshApps, state } from '../state.js';
import { envEditor } from '../env-editor.js';
import { filesTab } from './files.js';
import {
  $,
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
  toast,
  toggle,
  withBusy,
} from '../ui.js';

const TABS = [
  { id: 'console', label: 'Console', icon: 'terminal' },
  { id: 'files', label: 'Fichiers', icon: 'folder' },
  { id: 'env', label: 'Variables', icon: 'key' },
  { id: 'deploy', label: 'Déploiement', icon: 'upload' },
  { id: 'settings', label: 'Paramètres', icon: 'sliders' },
  { id: 'users', label: 'Utilisateurs', icon: 'users' },
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

  const renderers = { console: consoleTab, files: filesTab, env: envTab, deploy: deployTab, settings: settingsTab, users: usersTab };
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
    html`<div class="page-header app-header">
      <div class="title">
        <div class="app-icon lg ${app.type}">${icon(type.icon)}</div>
        <div class="app-title">
          <div class="row"><h1 class="truncate">${app.name}</h1>${statusBadge(app)}</div>
          <div class="sub">${details.join(' · ')}</div>
        </div>
      </div>
      <span class="spacer"></span>
      ${app.domains.length || url
        ? html`<div class="row app-links">
            ${app.domains.map((d) => html`<a class="btn btn-ghost btn-sm" href="${domainUrl(d)}" target="_blank" rel="noopener">${icon('globe')} ${d}</a>`)}
            ${url ? html`<a class="btn btn-ghost btn-sm" href="${url}" target="_blank" rel="noopener">${icon('external')} Ouvrir</a>` : ''}
          </div>`
        : ''}
      <div class="row app-controls">
        ${active
          ? html`<button class="btn" data-action="stop" ${busy ? 'disabled' : ''}>${icon('stop')} Arrêter</button>`
          : html`<button class="btn btn-success" data-action="start" ${busy ? 'disabled' : ''}>${icon('play')} Démarrer</button>`}
        <button class="btn" data-action="restart" ${busy ? 'disabled' : ''}>${icon('restart')} Redémarrer</button>
        ${active ? html`<button class="btn btn-ghost btn-icon" data-action="kill" title="Forcer l'arrêt" aria-label="Forcer l'arrêt">${icon('zap')}</button>` : ''}
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
      ts.textContent = line.t ? formatLogTime(line.t) : '';
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

// ---- Variables -----------------------------------------------------------------
function envTab(el, page, app) {
  setHTML(
    el,
    html`<div class="card">
      <div class="card-header"><h2>${icon('key')} Variables d'environnement</h2></div>
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
        <div class="card-header"><h2>${icon('upload')} Mettre à jour</h2></div>
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
            ${filePicker({ name: 'file', accept: '.zip,.tar,.tar.gz,.tgz', label: 'Choisir une archive…' })}
            <span class="hint">Le contenu est copié dans le dossier de l'application. Un ZIP téléchargé depuis GitHub fonctionne tel quel.</span>
          </div>
          <label class="check">${toggle('clean')}<span>Vider le dossier avant l'import<small>Supprime tous les fichiers actuels (y compris .env et node_modules).</small></span></label>
          <label class="check">${toggle('deploy', true)}<span>Déployer ensuite<small>Installe les dépendances, build et redémarre.</small></span></label>
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
        <div class="card-header"><h2>${icon('sliders')} Configuration</h2></div>
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
                  <label>Nom(s) de domaine</label>
                  <input type="text" name="domains" class="mono" value="${app.domains.join(', ')}" placeholder="monsite.fr, www.monsite.fr" spellcheck="false" />
                  <span class="hint">Publiés en HTTPS par le tunnel Cloudflare (Paramètres → Tunnel Cloudflare).</span>
                </div>`
            : ''}
          <div class="full">
            <label class="check">${toggle('autoRestart', app.autoRestart)}<span>Redémarrage automatique en cas de plantage<small>Relance l'application si elle s'arrête de façon inattendue.</small></span></label>
            <label class="check">${toggle('startOnBoot', app.startOnBoot !== false)}<span>Démarrer avec le Raspberry Pi<small>Lance l'application à chaque démarrage du Raspberry Pi. Désactivé : elle reste arrêtée jusqu'à ce que vous cliquiez sur « Démarrer ». Un simple redémarrage du panel (mise à jour) remet toujours l'application dans son état précédent.</small></span></label>
          </div>
          <div class="full hint">Dossier sur le Raspberry Pi : <code>${app.dir}</code></div>
        </div>
        <div class="card-foot">
          <span class="hint">Les changements de commande ou de port s'appliquent au prochain redémarrage.</span>
          <span class="spacer"></span>
          <button class="btn btn-primary" type="submit">${icon('save')} Enregistrer</button>
        </div>
      </form>

      ${isAdmin()
        ? html`<div class="card">
            <div class="card-header danger-head"><h2>${icon('alert')} Zone dangereuse</h2></div>
            <div class="card-body row">
              <div>
                <div class="label">Supprimer l'application</div>
                <div class="hint">Arrête l'application et supprime définitivement ses fichiers et ses journaux.</div>
              </div>
              <span class="spacer"></span>
              <button class="btn btn-danger" data-delete>${icon('trash')} Supprimer</button>
            </div>
          </div>`
        : html`<p class="hint">Seul un administrateur peut supprimer une application.</p>`}
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
  const initial = (name) => (name || '?').slice(0, 1).toUpperCase();

  const draw = () => {
    const { owner, members, candidates, canManage } = info;
    setHTML(
      el,
      html`<div class="card">
        <div class="card-header">
          <h2>${icon('users')} Utilisateurs de l'application</h2>
          <span class="spacer"></span>
          <span class="badge plain">${1 + members.length} compte${members.length ? 's' : ''}</span>
        </div>
        <div class="card-body">
          <p class="muted members-intro">Ces comptes voient l'application et peuvent tout faire dessus : la démarrer, utiliser la console, modifier ses fichiers et ses variables, la déployer. Les administrateurs ont accès à toutes les applications et n'apparaissent pas dans cette liste.</p>
          <ul class="member-list">
            <li class="member owner">
              <div class="avatar">${owner?.deleted ? icon('user') : initial(owner?.username)}</div>
              <div class="member-name">
                ${owner?.deleted ? html`<span class="muted">Compte supprimé</span>` : owner ? html`<b>${owner.username}</b>` : html`<span class="muted">Créateur inconnu</span>`}
                ${owner?.id === state.user.id ? html` <span class="faint">(vous)</span>` : ''}
              </div>
              <span class="badge accent">${icon('lock')} Créateur</span>
            </li>
            ${members.map(
              (m) => html`<li class="member">
                <div class="avatar">${initial(m.username)}</div>
                <div class="member-name"><b>${m.username}</b>${m.id === state.user.id ? html` <span class="faint">(vous)</span>` : ''}</div>
                ${canManage ? html`<button class="btn btn-ghost btn-sm" data-remove="${m.id}" data-name="${m.username}">${icon('x')} Retirer</button>` : ''}
              </li>`,
            )}
          </ul>
          ${!members.length ? html`<p class="hint">Personne d'autre n'a encore accès à cette application.</p>` : ''}
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
            : html`<div class="card-foot"><span class="hint">Tous les utilisateurs ont déjà accès.${isAdmin() ? html` Pour en créer d'autres : <a href="#/settings/utilisateurs">Paramètres → Utilisateurs</a>.` : ''}</span></div>`
          : html`<div class="card-foot"><span class="hint">${icon('lock')} Seuls le créateur de l'application et les administrateurs peuvent modifier cette liste.</span></div>`}
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

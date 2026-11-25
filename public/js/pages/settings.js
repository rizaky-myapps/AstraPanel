import { api } from '../api.js';
import { isAdmin, state } from '../state.js';
import {
  $,
  ROLE_LABEL,
  confirmDialog,
  copyText,
  formatDate,
  formatLogTime,
  formatTime,
  html,
  icon,
  modal,
  routingWarnings,
  setHTML,
  toast,
  toggle,
  withBusy,
} from '../ui.js';

const TABS = [
  { id: 'compte', label: 'Mon compte', icon: 'user' },
  { id: 'utilisateurs', label: 'Utilisateurs', icon: 'users', admin: true },
  { id: 'mises-a-jour', label: 'Mises à jour', icon: 'arrowUpCircle', admin: true },
  { id: 'tunnel', label: 'Tunnel Cloudflare', icon: 'cloud', admin: true },
  { id: 'general', label: 'Général', icon: 'sliders', admin: true },
];

const short = (sha) => (sha ? sha.slice(0, 7) : '—');
const rerender = () => window.dispatchEvent(new HashChangeEvent('hashchange'));

export function renderSettings(view, page, tab = 'compte') {
  const tabs = TABS.filter((t) => !t.admin || isAdmin());
  if (!tabs.some((t) => t.id === tab)) tab = 'compte';
  const root = document.createElement('div');
  view.replaceChildren(root);
  setHTML(
    root,
    html`<div class="page-header"><div><h1>Paramètres</h1><div class="sub">Compte, utilisateurs, mises à jour et publication des sites.</div></div></div>
      ${tabs.length > 1 ? html`<nav class="tabs">${tabs.map((t) => html`<a href="#/settings/${t.id}" class="${t.id === tab ? 'active' : ''}">${icon(t.icon)} ${t.label}</a>`)}</nav>` : ''}
      <div id="settings-tab"></div>`,
  );
  const el = $('#settings-tab', root);
  const renderers = { compte: accountTab, utilisateurs: usersTab, 'mises-a-jour': updateTab, tunnel: tunnelTab, general: generalTab };
  return Promise.resolve(renderers[tab](el, page)).catch((err) => {
    if (page.active) setHTML(el, html`<div class="alert err">${icon('alert')}<div>${err.message}</div></div>`);
  });
}

// ---- Mon compte ----------------------------------------------------------------
function accountTab(el) {
  const u = state.user;
  setHTML(
    el,
    html`<div class="grid grid-2">
      <div class="card">
        <div class="card-header"><h2>${icon('user')} Profil</h2></div>
        <div class="card-body row">
          <div class="avatar lg">${u.username.slice(0, 1).toUpperCase()}</div>
          <div>
            <div class="label">${u.username}</div>
            <span class="badge plain role-${u.role}">${ROLE_LABEL[u.role]}</span>
          </div>
        </div>
        <div class="card-body hint" style="padding-top:0">
          ${u.role === 'admin'
            ? 'Administrateur : accès complet (applications, utilisateurs, mises à jour, tunnel, stockage).'
            : 'Utilisateur : gestion des applications (console, fichiers, variables, déploiement). Les paramètres du panel sont réservés aux administrateurs.'}
        </div>
      </div>
      <form class="card" id="password-form">
        <div class="card-header"><h2>${icon('shield')} Mot de passe</h2></div>
        <div class="card-body">
          <div class="field"><label>Mot de passe actuel</label><input type="password" name="current" autocomplete="current-password" /></div>
          <div class="field"><label>Nouveau mot de passe</label><input type="password" name="next" autocomplete="new-password" /></div>
          <div class="field"><label>Confirmation</label><input type="password" name="confirm" autocomplete="new-password" /></div>
        </div>
        <div class="card-foot"><button class="btn btn-primary" type="submit">Changer le mot de passe</button></div>
      </form>
    </div>`,
  );
  $('#password-form', el).addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    const values = Object.fromEntries(new FormData(form));
    if (values.next !== values.confirm) {
      toast('Les mots de passe ne correspondent pas', 'err');
      return;
    }
    withBusy($('[type=submit]', form), async () => {
      await api.post('/auth/password', { current: values.current, next: values.next });
      form.reset();
      toast('Mot de passe modifié. Les autres sessions ont été déconnectées.');
    });
  });
}

// ---- Utilisateurs ----------------------------------------------------------------
const roleSelect = (name, value) =>
  html`<select name="${name}">${Object.entries(ROLE_LABEL).map(([v, label]) => html`<option value="${v}" ${v === value ? 'selected' : ''}>${label}</option>`)}</select>`;

async function usersTab(el, page) {
  const users = await api.get('/users');
  if (!page.active) return;
  setHTML(
    el,
    html`<div class="card">
      <div class="card-header">
        <h2>${icon('users')} Utilisateurs</h2>
        <span class="spacer"></span>
        <button class="btn btn-sm btn-primary" data-add>${icon('plus')} Ajouter un utilisateur</button>
      </div>
      <div class="fm-scroll">
        <table class="table">
          <thead><tr><th>Nom</th><th>Grade</th><th class="hide-sm">Créé le</th><th></th></tr></thead>
          <tbody>
            ${users.map(
              (u) => html`<tr data-id="${u.id}" data-name="${u.username}">
                <td><div class="row"><div class="avatar">${u.username.slice(0, 1).toUpperCase()}</div>${u.username}${u.id === state.user.id ? html` <span class="faint">(vous)</span>` : ''}</div></td>
                <td class="role-cell">${roleSelect('role', u.role)}</td>
                <td class="muted hide-sm">${formatDate(u.createdAt)}</td>
                <td>
                  <div class="file-actions">
                    <button class="btn btn-ghost btn-sm btn-icon" title="Définir un nouveau mot de passe" data-password>${icon('key')}</button>
                    ${u.id === state.user.id ? '' : html`<button class="btn btn-ghost btn-sm btn-icon" title="Supprimer" data-del>${icon('trash')}</button>`}
                  </div>
                </td>
              </tr>`,
            )}
          </tbody>
        </table>
      </div>
      <div class="card-body hint">
        <b>Administrateur</b> : accès complet (paramètres, utilisateurs, mises à jour, tunnel, stockage, suppression d'applications).
        <b>Utilisateur</b> : gère les applications (démarrer, console, fichiers, variables, déploiement) et son mot de passe.
        Il reste toujours au moins un administrateur.
      </div>
    </div>`,
  );

  el.addEventListener('change', (e) => {
    if (!e.target.matches('select[name=role]')) return;
    const row = e.target.closest('tr');
    const select = e.target;
    withBusy(select, async () => {
      try {
        await api.patch(`/users/${row.dataset.id}`, { role: select.value });
        toast(`${row.dataset.name} est maintenant ${ROLE_LABEL[select.value].toLowerCase()}`);
        if (row.dataset.id === state.user.id && select.value !== 'admin') location.reload();
      } catch (err) {
        rerender();
        throw err;
      }
    });
  });

  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-add]')) {
      const created = await modal({
        title: 'Nouvel utilisateur',
        confirmLabel: 'Créer',
        body: html`<div class="field"><label>Nom d'utilisateur</label><input type="text" name="username" autocomplete="off" /></div>
          <div class="field"><label>Mot de passe</label><input type="password" name="password" autocomplete="new-password" /><span class="hint">8 caractères minimum.</span></div>
          <div class="field"><label>Grade</label>${roleSelect('role', 'user')}</div>`,
        onConfirm: (values) => api.post('/users', values),
      });
      if (created) {
        toast(`Utilisateur ${created.username} créé`);
        rerender();
      }
      return;
    }
    const row = e.target.closest('tr[data-id]');
    if (!row) return;
    if (e.target.closest('[data-password]')) {
      const done = await modal({
        title: `Nouveau mot de passe pour ${row.dataset.name}`,
        confirmLabel: 'Enregistrer',
        body: html`<div class="field"><label>Mot de passe</label><input type="password" name="password" autocomplete="new-password" /><span class="hint">L'utilisateur sera déconnecté de ses sessions.</span></div>`,
        onConfirm: (values) => api.patch(`/users/${row.dataset.id}`, { password: values.password }),
      });
      if (done) toast('Mot de passe modifié');
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      if (!(await confirmDialog('Supprimer cet utilisateur ?', `${row.dataset.name} ne pourra plus se connecter.`, { danger: true, confirmLabel: 'Supprimer' }))) return;
      await withBusy(del, async () => {
        await api.del(`/users/${row.dataset.id}`);
        rerender();
      });
    }
  });
}

// ---- Mises à jour ------------------------------------------------------------------
async function updateTab(el, page) {
  let info = await api.get('/update');
  if (!page.active) return;
  let logTimer = null;
  page.onCleanup(() => clearTimeout(logTimer));

  const draw = () => {
    const inst = info.installed;
    setHTML(
      el,
      html`<div class="stack">
        <div class="card">
          <div class="card-header"><h2>${icon('arrowUpCircle')} Version installée</h2></div>
          <div class="card-body">
            ${!inst ? html`<div class="alert warn">${icon('alert')}<div>Ce panel n'a pas été installé depuis un clone Git : la mise à jour automatique est indisponible. Réinstallez-le avec <code>install.sh</code>.</div></div>` : ''}
            ${inst && !info.updater
              ? html`<div class="alert warn">${icon('alert')}<div>Le service de mise à jour n'est pas encore installé sur le Pi. Faites une dernière mise à jour en SSH, en réinstallant la dernière version (tutoriel, étape 5 : <code>git clone</code> puis <code>sudo ./install.sh</code>) : les suivantes se feront d'ici.</div></div>`
              : ''}
            ${info.error ? html`<div class="alert err">${icon('alert')}<div>${info.error}</div></div>` : ''}
            ${inst
              ? html`<table class="table kv-table">
                  <tbody>
                    <tr><td class="muted">Version</td><td><b>${inst.version}</b> <span class="muted">· branche <code>${inst.branch}</code> · commit <code>${short(inst.commit)}</code></span></td></tr>
                    ${inst.installedAt ? html`<tr><td class="muted">Installée le</td><td>${formatDate(inst.installedAt)}</td></tr>` : ''}
                    <tr><td class="muted">Dépôt</td><td class="mono truncate">${inst.repo || '—'}</td></tr>
                    <tr><td class="muted">Dernière vérification</td><td>${info.checking ? 'en cours…' : info.lastCheck ? formatDate(info.lastCheck) : 'jamais'}</td></tr>
                  </tbody>
                </table>`
              : ''}
          </div>
          ${inst
            ? html`<form class="card-foot" id="branch-form">
                <label class="muted nowrap" for="branch">Branche suivie</label>
                <select id="branch" name="branch">
                  <option value="" ${info.auto ? 'selected' : ''}>Automatique : dernière version publiée${info.auto ? ` (${info.branch})` : ''}</option>
                  ${info.branches.map((b) => html`<option value="${b}" ${!info.auto && b === info.branch ? 'selected' : ''}>${b}</option>`)}
                  ${!info.auto && !info.branches.includes(info.branch) ? html`<option value="${info.branch}" selected>${info.branch}</option>` : ''}
                </select>
                <span class="spacer"></span>
                <button class="btn" type="submit">${icon('refresh')} Vérifier les mises à jour</button>
              </form>`
            : ''}
        </div>

        ${info.available
          ? html`<div class="card highlight">
              <div class="card-header">
                <h2>${icon('sparkles')} Nouvelle version disponible${info.latestVersion ? ` : ${info.latestVersion}` : ''}</h2>
                <span class="spacer"></span>
                <code>${short(info.latest)}</code>
              </div>
              <div class="card-body">
                ${info.commits.length
                  ? html`<ul class="commits">
                      ${info.commits.map((c) => html`<li><span>${c.message}</span><span class="muted"> — ${c.author}${c.date ? `, ${formatDate(c.date)}` : ''}</span></li>`)}
                    </ul>`
                  : html`<p class="muted">De nouveaux changements sont disponibles sur la branche « ${info.branch} ».</p>`}
                <p class="hint">Pendant la mise à jour (1 à 3 minutes), le panel redémarre et vos applications sont relancées automatiquement.</p>
              </div>
              <div class="card-foot">
                <button class="btn btn-primary" data-apply ${info.updater && !info.pending ? '' : 'disabled'}>${icon('arrowUpCircle')} Mettre à jour maintenant</button>
              </div>
            </div>`
          : inst && info.latest
            ? html`<div class="alert info">${icon('check')}<div>Le panel est à jour (dernière version : « ${info.branch} »).</div></div>`
            : ''}

        <div class="card ${info.run || info.pending ? '' : 'hidden'}" id="run-card">
          <div class="card-header"><h2>${icon('terminal')} Dernière mise à jour</h2><span class="spacer"></span><span id="run-state"></span></div>
          <pre class="code update-log" id="update-log"></pre>
        </div>
      </div>`,
    );

    $('#branch-form', el)?.addEventListener('submit', (e) => {
      e.preventDefault();
      const branch = e.target.branch.value;
      const current = info.auto ? '' : info.branch;
      withBusy($('[type=submit]', e.target), async () => {
        info = branch !== current ? await api.post('/update/branch', { branch }) : await api.post('/update/check');
        if (!page.active) return;
        draw();
        if (!info.error) toast(info.available ? 'Une nouvelle version est disponible' : 'Le panel est à jour', info.available ? 'info' : 'ok');
      });
    });
    $('[data-apply]', el)?.addEventListener('click', async (e) => {
      if (!(await confirmDialog('Mettre à jour AstraPanel ?', 'Le panel va télécharger la nouvelle version puis redémarrer. Cela prend 1 à 3 minutes.', { confirmLabel: 'Mettre à jour' }))) return;
      await withBusy(e.target.closest('button'), async () => {
        await api.post('/update/apply');
        startedAt = Date.now();
        $('#run-card', el).classList.remove('hidden');
        followLog();
      });
    });
    if (info.run || info.pending) followLog();
  };

  // Suit le journal de la mise à jour ; le panel redémarre en cours de route (requêtes en échec un moment).
  let startedAt = 0;
  async function followLog() {
    clearTimeout(logTimer);
    const stateEl = $('#run-state', el);
    const logEl = $('#update-log', el);
    if (!stateEl) return;
    try {
      const { log, run } = await api.get('/update/log');
      if (!page.active) return;
      logEl.textContent = log || 'En attente du service de mise à jour…';
      logEl.scrollTop = logEl.scrollHeight;
      const fresh = run && run.at >= startedAt - 5000;
      if (run?.state === 'done' && startedAt && fresh) {
        stateEl.innerHTML = String(html`<span class="badge st-running">Terminée</span>`);
        toast('Mise à jour terminée : rechargement du panel…');
        setTimeout(() => location.reload(), 2500);
        return;
      }
      if (run?.state === 'failed') {
        stateEl.innerHTML = String(html`<span class="badge st-crashed">Échec</span>`);
        return;
      } else if (run?.state === 'done') {
        stateEl.innerHTML = String(html`<span class="badge plain">${formatDate(run.at)}</span>`);
        if (!startedAt) return;
      } else {
        stateEl.innerHTML = String(html`<span class="badge st-busy">${run?.message || 'En attente…'}</span>`);
      }
    } catch {
      stateEl.innerHTML = String(html`<span class="badge st-restarting">Redémarrage du panel…</span>`);
    }
    if (page.active) logTimer = setTimeout(followLog, 2000);
  }

  draw();
}

// ---- Tunnel Cloudflare ----------------------------------------------------------------
async function tunnelTab(el, page) {
  let status = await api.get('/tunnel');
  if (!page.active) return;
  let mode = status.mode;
  let accounts = null;
  let pollTimer = null;
  let source = null;
  page.onCleanup(() => {
    clearTimeout(pollTimer);
    source?.close();
  });

  const connection = () => {
    if (!status.running) return html`<span class="badge">Arrêté</span>`;
    if (status.ready?.readyConnections > 0) return html`<span class="badge st-running">Connecté · ${status.ready.readyConnections} liaison(s)</span>`;
    return html`<span class="badge st-restarting">Connexion…</span>`;
  };
  const configured = status.mode === 'api' ? Boolean(status.api.tunnelId) : Boolean(status.token);

  function draw() {
    setHTML(
      el,
      html`<div class="stack">
        <div class="alert info">${icon('cloud')}<div>
          Le <b>tunnel Cloudflare</b> met vos sites en ligne sur votre nom de domaine, en HTTPS, <b>sans ouvrir de port sur votre box</b>
          (il fonctionne même sans IPv4 publique). Le Raspberry Pi garde une connexion sortante vers Cloudflare, qui lui transmet les visites.
          Il faut un domaine géré par Cloudflare (offre gratuite).
          ${status.guide ? html`<br /><a href="${status.guide}" target="_blank" rel="noopener">${icon('external')} Tutoriel pas à pas (domaine, jeton d'API, tunnel)</a>` : ''}
        </div></div>

        <div class="card">
          <div class="card-header"><h2>${icon('server')} État</h2><span class="spacer"></span><span id="conn-badge">${connection()}</span></div>
          <div class="card-body tunnel-status">
            <div class="row">
              <div>
                <div class="label">cloudflared</div>
                <div class="hint">${status.binary ? `Version ${status.version || 'inconnue'}${status.binary === 'cloudflared' ? ' (installée sur le système)' : ''}` : 'Non installé'}</div>
              </div>
              <span class="spacer"></span>
              <button class="btn btn-sm" data-install>${icon('download')} ${status.binary ? 'Mettre à jour' : 'Installer cloudflared'}</button>
            </div>
            <div class="row">
              <div>
                <div class="label">Tunnel actif</div>
                <div class="hint">${configured ? 'Démarre automatiquement avec le panel.' : 'Configurez d’abord un tunnel ci-dessous.'}</div>
              </div>
              <span class="spacer"></span>
              <button class="btn btn-ghost btn-sm" data-restart ${status.running ? '' : 'disabled'}>${icon('restart')} Redémarrer</button>
              <label class="check inline">${toggle('enabled', status.enabled, { id: 'tunnel-enabled', disabled: !configured || !status.binary, label: 'Tunnel actif' })}</label>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header"><h2>${icon('sliders')} Mode de gestion</h2></div>
          <div class="card-body">
            <div class="choices">
              <button type="button" class="choice ${mode === 'api' ? 'selected' : ''}" data-mode="api">
                <div class="t">${icon('sparkles')} Géré depuis le panel</div>
                <div class="d">Recommandé. Avec un jeton d'API, le panel crée le tunnel et les enregistrements DNS : ajoutez un domaine à une application, il est en ligne.</div>
              </button>
              <button type="button" class="choice ${mode === 'token' ? 'selected' : ''}" data-mode="token">
                <div class="t">${icon('globe')} Géré depuis le site Cloudflare</div>
                <div class="d">Vous créez le tunnel et ses adresses publiques dans le tableau de bord Cloudflare ; le panel fait seulement tourner le tunnel.</div>
              </button>
            </div>
          </div>
          <div class="card-body" id="mode-body" style="padding-top:0"></div>
        </div>

        <div class="card">
          <div class="card-header"><h2>${icon('terminal')} Journal du tunnel</h2></div>
          <div class="console small"><div class="console-output" id="tunnel-log"></div></div>
        </div>

        ${configured || status.api.connected
          ? html`<div class="row"><span class="spacer"></span><button class="btn btn-danger btn-sm" data-reset>${icon('trash')} Supprimer la configuration du tunnel</button></div>`
          : ''}
      </div>`,
    );
    drawMode();
    openLog();
  }

  const appsTable = () =>
    html`<table class="table compact">
      <thead><tr><th>Application</th><th>Service à indiquer dans Cloudflare</th></tr></thead>
      <tbody>
        ${state.apps.filter((a) => a.port).length
          ? state.apps.filter((a) => a.port).map((a) => html`<tr><td>${a.name}</td><td><code>http://localhost:${a.port}</code></td></tr>`)
          : html`<tr><td colspan="2" class="muted">Aucun site pour l'instant.</td></tr>`}
        <tr><td>Panel AstraPanel</td><td><code>http://localhost:${location.port || '8080'}</code></td></tr>
      </tbody>
    </table>`;

  function drawMode() {
    const box = $('#mode-body', el);
    if (mode === 'token') {
      setHTML(
        box,
        html`${status.mode === 'token' && status.token
            ? html`<div class="alert info">${icon('check')}<div>Tunnel configuré : <code>${status.token.tunnelId}</code></div></div>`
            : ''}
          <ol class="steps">
            <li>Sur <a href="https://dash.cloudflare.com/" target="_blank" rel="noopener">dash.cloudflare.com</a>, ouvrez <b>Networking → Tunnels</b>, cliquez sur <b>Create a tunnel</b>, donnez un nom puis <b>Create Tunnel</b>.</li>
            <li>Choisissez le système <b>Debian</b> et copiez la commande affichée (elle contient le jeton qui commence par <code>eyJ</code>). <b>Ne la lancez pas sur le Pi</b> : collez-la ci-dessous.</li>
            <li>Dans le tunnel, onglet <b>Routes</b> → <b>Add route</b> → <b>Published application</b> : un domaine par site, avec en <b>Service URL</b> l'adresse indiquée dans ce tableau :</li>
          </ol>
          ${appsTable()}
          <form id="token-form" style="margin-top:16px">
            <div class="field">
              <label>Jeton du tunnel (ou commande complète)</label>
              <textarea name="token" class="mono" rows="3" placeholder="cloudflared service install eyJhIjoi…" spellcheck="false"></textarea>
            </div>
            <div class="row"><span class="spacer"></span><button class="btn btn-primary" type="submit">${icon('save')} Enregistrer et démarrer</button></div>
          </form>`,
      );
      $('#token-form', box).addEventListener('submit', (e) => {
        e.preventDefault();
        const token = e.target.token.value;
        withBusy($('[type=submit]', e.target), async () => {
          if (!status.binary) await api.post('/tunnel/install');
          status = await api.post('/tunnel/token', { token });
          toast('Tunnel enregistré et démarré');
          refresh(true);
        });
      });
      return;
    }

    // Mode API
    const a = status.api;
    setHTML(
      box,
      html`<div class="steps-grid">
        <div class="step ${a.connected ? 'done' : ''}">
          <div class="step-title">1. Jeton d'API Cloudflare</div>
          ${a.connected
            ? html`<p class="hint">Jeton enregistré <code>${a.apiToken}</code>.</p>`
            : html`<p class="hint">
                Sur <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener">dash.cloudflare.com/profile/api-tokens</a> :
                <b>Create Token</b> → <b>Custom token</b>, avec les permissions <b>Account · Cloudflare Tunnel · Edit</b>,
                <b>Zone · DNS · Edit</b> et <b>Zone · Zone · Read</b> (zones : toutes, ou celles de vos domaines).
              </p>`}
          <form id="api-form" class="input-group">
            <input type="password" name="apiToken" class="mono" placeholder="${a.connected ? 'Remplacer le jeton…' : 'Collez le jeton d’API'}" autocomplete="off" />
            <button class="btn" type="submit">${a.connected ? 'Remplacer' : 'Connecter'}</button>
          </form>
        </div>
        <div class="step ${a.tunnelId ? 'done' : ''} ${a.connected ? '' : 'disabled'}">
          <div class="step-title">2. Tunnel</div>
          ${a.tunnelId
            ? html`<p class="hint">Tunnel <b>${a.tunnelName}</b> sur le compte ${a.accountName} (<code>${a.tunnelId.slice(0, 8)}…</code>).</p>`
            : html`<p class="hint">Le panel crée le tunnel sur votre compte (ou réutilise celui qui porte ce nom).</p>`}
          <form id="setup-form" class="stack-sm">
            <select name="accountId" ${a.connected ? '' : 'disabled'}>
              ${accounts
                ? accounts.map((x) => html`<option value="${x.id}" ${x.id === a.accountId ? 'selected' : ''}>${x.name}</option>`)
                : a.accountId
                  ? html`<option value="${a.accountId}">${a.accountName}</option>`
                  : html`<option value="">Compte Cloudflare…</option>`}
            </select>
            <div class="input-group">
              <input type="text" name="name" class="mono" value="${a.tunnelName || `astrapanel-${location.hostname.split('.')[0] || 'pi'}`}" ${a.connected ? '' : 'disabled'} />
              <button class="btn btn-primary" type="submit" ${a.connected ? '' : 'disabled'}>${a.tunnelId ? 'Relier' : 'Créer le tunnel'}</button>
            </div>
          </form>
        </div>
      </div>
      ${a.tunnelId ? routesCard() : ''}`,
    );

    $('#api-form', box).addEventListener('submit', (e) => {
      e.preventDefault();
      const apiToken = e.target.apiToken.value;
      withBusy($('[type=submit]', e.target), async () => {
        ({ accounts } = await api.post('/tunnel/api/connect', { apiToken }));
        status = await api.get('/tunnel');
        toast('Jeton d’API vérifié');
        drawMode();
      });
    });
    if (a.connected && !accounts) {
      api.get('/tunnel/api/accounts').then(
        (r) => {
          accounts = r.accounts;
          if (page.active && mode === 'api' && !$('#setup-form [name=accountId]:focus', el)) drawMode();
        },
        (err) => toast(err.message, 'err'),
      );
    }
    $('#setup-form', box).addEventListener('submit', (e) => {
      e.preventDefault();
      const { accountId, name } = Object.fromEntries(new FormData(e.target));
      withBusy($('[type=submit]', e.target), async () => {
        if (!status.binary) await api.post('/tunnel/install');
        const result = await api.post('/tunnel/api/setup', { accountId, name });
        status = result.status;
        routingWarnings({ tunnel: result.sync });
        toast('Tunnel prêt');
        refresh(true);
      });
    });
    box.querySelector('[data-sync]')?.addEventListener('click', (e) =>
      withBusy(e.currentTarget, async () => {
        const r = await api.post('/tunnel/sync');
        if (routingWarnings({ tunnel: r })) toast('Domaines synchronisés');
        refresh(true);
      }),
    );
    box.querySelectorAll('[data-replace]').forEach((b) =>
      b.addEventListener('click', async () => {
        const host = b.dataset.replace;
        if (!(await confirmDialog('Remplacer l’enregistrement DNS ?', `L'enregistrement DNS actuel de ${host} sera supprimé et remplacé par celui du tunnel.`, { danger: true, confirmLabel: 'Remplacer' }))) return;
        await withBusy(b, async () => {
          const r = await api.post('/tunnel/dns/replace', { hostname: host });
          routingWarnings({ tunnel: r });
          refresh(true);
        });
      }),
    );
  }

  function routesCard() {
    const synced = new Map((status.lastSync?.routes || []).map((r) => [r.hostname, r]));
    const STATUS = { ok: ['st-running', 'En ligne'], conflict: ['st-crashed', 'Conflit DNS'], 'no-zone': ['st-restarting', 'Domaine inconnu'], error: ['st-crashed', 'Erreur'] };
    return html`<div class="card inner">
      <div class="card-header">
        <h3>${icon('globe')} Domaines publiés</h3>
        <span class="spacer"></span>
        ${status.lastSync ? html`<span class="hint hide-sm">Synchronisé à ${formatTime(status.lastSync.at)}</span>` : ''}
        <button class="btn btn-sm" data-sync>${icon('refresh')} Synchroniser</button>
      </div>
      ${status.lastSync?.error && !synced.size ? html`<div class="alert err" style="margin:12px">${icon('alert')}<div>${status.lastSync.error}</div></div>` : ''}
      <div class="fm-scroll">
        <table class="table compact">
          <thead><tr><th>Domaine</th><th class="hide-sm">Vers</th><th>État</th><th></th></tr></thead>
          <tbody>
            ${status.routes.length
              ? status.routes.map((r) => {
                  const s = synced.get(r.hostname);
                  const [cls, label] = s ? STATUS[s.status] || ['', s.status] : ['', 'À synchroniser'];
                  return html`<tr>
                    <td><a href="https://${r.hostname}" target="_blank" rel="noopener">${r.hostname}</a><div class="hint">${r.label}</div></td>
                    <td class="hide-sm"><code>${r.service}</code></td>
                    <td><span class="badge ${cls}">${label}</span>${s && s.status !== 'ok' ? html`<div class="hint">${s.message}</div>` : ''}</td>
                    <td>${s?.status === 'conflict' ? html`<button class="btn btn-sm btn-ghost" data-replace="${r.hostname}">Remplacer</button>` : ''}</td>
                  </tr>`;
                })
              : html`<tr><td colspan="4" class="muted">Aucun domaine : ajoutez-en un dans l'onglet <b>Paramètres</b> d'une application (ou le domaine du panel dans Général).</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>`;
  }

  function openLog() {
    source?.close();
    const out = $('#tunnel-log', el);
    source = new EventSource('/api/tunnel/logs/stream');
    const add = (lines) => {
      for (const line of lines) {
        const row = document.createElement('div');
        row.className = `l ${line.s}`;
        const ts = document.createElement('span');
        ts.className = 'ts';
        ts.textContent = formatLogTime(line.t);
        const m = document.createElement('span');
        m.className = 'm';
        m.textContent = line.m;
        row.append(ts, m);
        out.appendChild(row);
      }
      while (out.childElementCount > 500) out.firstElementChild.remove();
      out.scrollTop = out.scrollHeight;
    };
    source.addEventListener('backlog', (e) => {
      out.textContent = '';
      const lines = JSON.parse(e.data);
      if (lines.length) add(lines);
      else out.innerHTML = String(html`<div class="console-empty">Le journal de cloudflared apparaîtra ici.</div>`);
    });
    source.onmessage = (e) => {
      out.querySelector('.console-empty')?.remove();
      add([JSON.parse(e.data)]);
    };
  }

  async function refresh(full = false) {
    clearTimeout(pollTimer);
    try {
      status = await api.get('/tunnel');
    } catch {
      // nouvel essai plus tard
    }
    if (!page.active) return;
    if (full) {
      mode = status.mode;
      rerender();
      return;
    }
    const badge = $('#conn-badge', el);
    if (badge) setHTML(badge, connection());
    pollTimer = setTimeout(() => refresh(), 5000);
  }

  el.addEventListener('click', async (e) => {
    const modeBtn = e.target.closest('[data-mode]');
    if (modeBtn && modeBtn.dataset.mode !== mode) {
      mode = modeBtn.dataset.mode;
      el.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('selected', b.dataset.mode === mode));
      drawMode();
      return;
    }
    const install = e.target.closest('[data-install]');
    if (install) {
      await withBusy(install, async () => {
        const { version } = await api.post('/tunnel/install');
        toast(`cloudflared ${version} installé`);
        refresh(true);
      });
      return;
    }
    const restart = e.target.closest('[data-restart]');
    if (restart) {
      await withBusy(restart, async () => {
        status = await api.post('/tunnel/restart');
        toast('Tunnel redémarré');
      });
      return;
    }
    if (e.target.closest('[data-reset]')) {
      if (!(await confirmDialog('Supprimer la configuration ?', 'Le tunnel sera arrêté et ses jetons effacés du panel. Le tunnel et les enregistrements DNS restent sur votre compte Cloudflare (supprimez-les depuis Cloudflare si besoin).', { danger: true, confirmLabel: 'Supprimer' }))) return;
      await api.post('/tunnel/reset');
      toast('Configuration du tunnel supprimée');
      refresh(true);
    }
  });

  el.addEventListener('change', (e) => {
    if (e.target.id !== 'tunnel-enabled') return;
    const input = e.target;
    withBusy(input, async () => {
      try {
        status = await api.post('/tunnel/enabled', { enabled: input.checked });
        toast(input.checked ? 'Tunnel démarré' : 'Tunnel arrêté');
        refresh();
      } catch (err) {
        input.checked = !input.checked;
        throw err;
      }
    });
  });

  draw();
  refresh();
}

// ---- Général ---------------------------------------------------------------------------
async function generalTab(el, page) {
  const { settings, panel } = await api.get('/settings');
  if (!page.active) return;
  setHTML(
    el,
    html`<div class="grid grid-2">
      <form class="card" id="domain-form">
        <div class="card-header"><h2>${icon('globe')} Domaine du panel</h2></div>
        <div class="card-body">
          <div class="field">
            <label>Nom de domaine <span class="faint">(optionnel)</span></label>
            <input type="text" name="panelDomain" class="mono" value="${settings.panelDomain}" placeholder="panel.mondomaine.fr" spellcheck="false" />
            <span class="hint">Pour administrer le panel en HTTPS depuis Internet, via le tunnel Cloudflare (mode « géré depuis le panel »).</span>
          </div>
        </div>
        <div class="card-foot"><button class="btn btn-primary" type="submit">${icon('save')} Enregistrer</button></div>
      </form>

      <form class="card" id="ports-form">
        <div class="card-header"><h2>${icon('server')} Ports des sites</h2></div>
        <div class="card-body">
          <p class="hint" style="margin-top:0">Plage dans laquelle le panel choisit automatiquement le port des nouveaux sites.</p>
          <div class="form-grid">
            <div class="field"><label>Premier port</label><input type="number" name="start" value="${settings.portRange.start}" min="1024" max="65535" /></div>
            <div class="field"><label>Dernier port</label><input type="number" name="end" value="${settings.portRange.end}" min="1024" max="65535" /></div>
          </div>
        </div>
        <div class="card-foot"><button class="btn" type="submit">${icon('save')} Enregistrer</button></div>
      </form>

      <div class="card">
        <div class="card-header"><h2>${icon('info')} À propos</h2></div>
        <table class="table">
          <tbody>
            <tr><td class="muted">Version</td><td>AstraPanel ${panel.version}</td></tr>
            <tr><td class="muted">Node.js</td><td>${panel.node}</td></tr>
            <tr><td class="muted">Port du panel</td><td>${panel.port}</td></tr>
            <tr><td class="muted">Données</td><td><code>${panel.dataDir}</code> <button class="btn btn-ghost btn-sm btn-icon" data-copy="${panel.dataDir}" title="Copier">${icon('copy')}</button></td></tr>
          </tbody>
        </table>
      </div>
    </div>`,
  );
  $('#domain-form', el).addEventListener('submit', (e) => {
    e.preventDefault();
    withBusy($('[type=submit]', e.target), async () => {
      const result = await api.patch('/settings', { panelDomain: e.target.panelDomain.value });
      if (routingWarnings(result)) toast('Domaine du panel enregistré');
    });
  });
  $('#ports-form', el).addEventListener('submit', (e) => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(e.target));
    withBusy($('[type=submit]', e.target), async () => {
      await api.patch('/settings', { portRange: { start: Number(values.start), end: Number(values.end) } });
      toast('Plage de ports enregistrée');
    });
  });
  el.querySelector('[data-copy]')?.addEventListener('click', (e) => copyText(e.currentTarget.dataset.copy));
}

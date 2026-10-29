import { api } from '../api.js';
import { state } from '../state.js';
import { $, confirmDialog, formatDate, html, icon, modal, setHTML, toast, withBusy } from '../ui.js';

export async function renderSettings(view, page) {
  const [data, users] = await Promise.all([api.get('/settings'), api.get('/users')]);
  if (!page.active) return;
  const root = document.createElement('div');
  view.replaceChildren(root);
  const { settings, caddy, panel } = data;
  const caddyMode = settings.caddy.enabled === null ? 'auto' : settings.caddy.enabled ? 'on' : 'off';

  setHTML(
    root,
    html`<div class="page-header"><div><h1>Paramètres</h1><div class="sub">Compte, utilisateurs, HTTPS et réseau.</div></div></div>
      <div class="stack">
        <div class="grid grid-2">
          <form class="card" id="password-form">
            <div class="card-header"><h2>${icon('shield')} Mon mot de passe</h2></div>
            <div class="card-body">
              <div class="field"><label>Mot de passe actuel</label><input type="password" name="current" autocomplete="current-password" /></div>
              <div class="field"><label>Nouveau mot de passe</label><input type="password" name="next" autocomplete="new-password" /></div>
              <div class="field"><label>Confirmation</label><input type="password" name="confirm" autocomplete="new-password" /></div>
            </div>
            <div class="card-foot"><button class="btn btn-primary" type="submit">Changer le mot de passe</button></div>
          </form>

          <div class="card">
            <div class="card-header">
              <h2>${icon('users')} Utilisateurs</h2>
              <span class="spacer"></span>
              <button class="btn btn-sm" data-add-user>${icon('plus')} Ajouter</button>
            </div>
            <table class="table">
              <tbody>
                ${users.map(
                  (u) => html`<tr>
                    <td><div class="row"><div class="avatar">${u.username.slice(0, 1).toUpperCase()}</div>${u.username}${u.id === state.user.id ? html` <span class="faint">(vous)</span>` : ''}</div></td>
                    <td class="muted hide-sm">créé le ${formatDate(u.createdAt)}</td>
                    <td>${u.id === state.user.id ? '' : html`<button class="btn btn-ghost btn-sm btn-icon" title="Supprimer" data-del-user="${u.id}" data-name="${u.username}">${icon('trash')}</button>`}</td>
                  </tr>`,
                )}
              </tbody>
            </table>
            <div class="card-body hint">Tous les utilisateurs ont les mêmes droits (accès complet au panel).</div>
          </div>
        </div>

        <form class="card" id="caddy-form">
          <div class="card-header"><h2>${icon('globe')} Noms de domaine & HTTPS (Caddy)</h2></div>
          <div class="card-body">
            <p class="muted" style="margin-top:0">
              Caddy reçoit les visites sur les ports 80/443, obtient automatiquement les certificats HTTPS (Let's Encrypt)
              et redirige chaque domaine vers la bonne application.
            </p>
            <div class="alert ${caddy.version ? 'info' : 'warn'}">
              ${icon(caddy.version ? 'check' : 'alert')}
              <div>
                ${caddy.version ? html`Caddy <b>${caddy.version}</b> est installé.` : html`Caddy n'est pas installé. Relancez l'installateur avec <code>sudo ./install.sh --with-caddy</code>.`}
                ${caddy.dirWritable
                  ? html` Configuration écrite dans <code>${caddy.dir}</code>.`
                  : html` Le dossier <code>${caddy.dir}</code> n'est pas accessible en écriture par le panel.`}
                Statut : <b>${caddy.enabled ? 'activé' : 'désactivé'}</b>.
              </div>
            </div>
            ${caddy.lastError ? html`<div class="alert err">${icon('alert')}<div><b>Dernière erreur Caddy :</b> ${caddy.lastError}</div></div>` : ''}
            <div class="form-grid">
              <div class="field">
                <label>Intégration Caddy</label>
                <select name="caddyEnabled">
                  <option value="auto" ${caddyMode === 'auto' ? 'selected' : ''}>Automatique (si Caddy est installé)</option>
                  <option value="on" ${caddyMode === 'on' ? 'selected' : ''}>Activée</option>
                  <option value="off" ${caddyMode === 'off' ? 'selected' : ''}>Désactivée</option>
                </select>
              </div>
              <div class="field">
                <label>Domaine du panel <span class="faint">(optionnel)</span></label>
                <input type="text" name="panelDomain" class="mono" value="${settings.panelDomain}" placeholder="panel.mondomaine.fr" spellcheck="false" />
                <span class="hint">Pour accéder au panel en HTTPS depuis Internet.</span>
              </div>
            </div>
            <details>
              <summary>Voir la configuration générée</summary>
              <pre class="code">${caddy.preview}</pre>
            </details>
          </div>
          <div class="card-foot">
            <button class="btn btn-ghost" type="button" data-reload-caddy>${icon('refresh')} Recharger Caddy</button>
            <button class="btn btn-primary" type="submit">${icon('save')} Enregistrer</button>
          </div>
        </form>

        <div class="grid grid-2">
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
                <tr><td class="muted">Données</td><td><code>${panel.dataDir}</code></td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>`,
  );

  const rerender = () => renderSettings(view, page);

  $('#password-form', root).addEventListener('submit', (e) => {
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

  root.addEventListener('click', async (e) => {
    if (e.target.closest('[data-add-user]')) {
      const created = await modal({
        title: 'Nouvel utilisateur',
        confirmLabel: 'Créer',
        body: html`<div class="field"><label>Nom d'utilisateur</label><input type="text" name="username" autocomplete="off" /></div>
          <div class="field"><label>Mot de passe</label><input type="password" name="password" autocomplete="new-password" /></div>`,
        onConfirm: (values) => api.post('/users', values),
      });
      if (created) {
        toast(`Utilisateur ${created.username} créé`);
        rerender();
      }
    }
    const del = e.target.closest('[data-del-user]');
    if (del) {
      if (!(await confirmDialog('Supprimer cet utilisateur ?', `${del.dataset.name} ne pourra plus se connecter.`, { danger: true, confirmLabel: 'Supprimer' }))) return;
      await withBusy(del, async () => {
        await api.del(`/users/${del.dataset.delUser}`);
        rerender();
      });
    }
    const reload = e.target.closest('[data-reload-caddy]');
    if (reload) {
      withBusy(reload, async () => {
        const result = await api.post('/settings/caddy/apply');
        if (result.skipped) toast('Intégration Caddy désactivée', 'info');
        else if (result.ok) toast('Configuration Caddy rechargée');
        else toast(`Caddy : ${result.error}`, 'err');
        rerender();
      });
    }
  });

  $('#caddy-form', root).addEventListener('submit', (e) => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(e.target));
    const caddyEnabled = values.caddyEnabled === 'auto' ? null : values.caddyEnabled === 'on';
    withBusy($('[type=submit]', e.target), async () => {
      const result = await api.patch('/settings', { caddyEnabled, panelDomain: values.panelDomain });
      if (result.caddy && !result.caddy.ok) toast(`Enregistré, mais Caddy a refusé la configuration : ${result.caddy.error}`, 'err');
      else toast('Paramètres enregistrés');
      rerender();
    });
  });

  $('#ports-form', root).addEventListener('submit', (e) => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(e.target));
    withBusy($('[type=submit]', e.target), async () => {
      await api.patch('/settings', { portRange: { start: Number(values.start), end: Number(values.end) } });
      toast('Plage de ports enregistrée');
    });
  });
}

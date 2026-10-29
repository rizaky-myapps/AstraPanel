import { api, qs, upload } from '../api.js';
import { refreshApps } from '../state.js';
import { envEditor } from '../env-editor.js';
import { $, html, icon, setHTML, toast } from '../ui.js';

const TYPES = [
  { id: 'bot', title: 'Bot Discord', desc: 'Un bot discord.js, ou tout programme Node.js sans site web.', icon: 'bot' },
  { id: 'node', title: 'Site Node.js', desc: 'Express, Fastify, Next.js… Le port est fourni via PORT.', icon: 'globe' },
  { id: 'static', title: 'Site statique', desc: 'HTML / CSS / JS, ou le résultat d’un build (Vite, React…).', icon: 'layers' },
];

const SOURCES = [
  { id: 'template', title: 'Modèle de départ', icon: 'sparkles' },
  { id: 'git', title: 'Dépôt Git', icon: 'git' },
  { id: 'archive', title: 'Archive ZIP', icon: 'archive' },
  { id: 'empty', title: 'Dossier vide', icon: 'folder' },
];

const TEMPLATE_INFO = {
  bot: 'Un bot discord.js avec les commandes /ping et /text (envoyer un message via le bot). Il suffit d’ajouter votre DISCORD_TOKEN plus bas.',
  node: 'Un petit serveur web Node.js sans dépendance, qui écoute sur le port fourni par le panel.',
  static: 'Une page d’accueil HTML/CSS à remplacer par votre site.',
};

function defaultStart(type, source) {
  if (type === 'static') return '';
  if (source === 'template') return type === 'bot' ? 'node index.js' : 'node server.js';
  return 'npm start';
}

export function renderNewApp(view) {
  // Les écouteurs sont posés sur `root`, qui disparaît quand on change de page.
  const root = document.createElement('div');
  view.replaceChildren(root);
  const f = {
    type: 'bot',
    source: 'template',
    name: '',
    gitUrl: '',
    gitBranch: '',
    startCommand: 'node index.js',
    startTouched: false,
    installCommand: 'npm install',
    buildCommand: '',
    staticDir: '.',
    spa: false,
    port: '',
    domains: '',
    autoRestart: true,
    start: true,
  };
  let file = null;
  let envValues = { DISCORD_TOKEN: '' };
  let editor = null;

  function sourceDetails() {
    if (f.source === 'template') {
      return html`<div class="alert info" style="margin:16px 0 0">${icon('info')}<div>${TEMPLATE_INFO[f.type]}</div></div>`;
    }
    if (f.source === 'git') {
      return html`<div class="form-grid" style="margin-top:16px">
        <div class="field">
          <label>URL du dépôt</label>
          <input type="text" name="gitUrl" class="mono" value="${f.gitUrl}" placeholder="https://github.com/moi/mon-projet.git" spellcheck="false" />
          <span class="hint">Dépôt privé : <code>https://&lt;jeton&gt;@github.com/moi/projet.git</code></span>
        </div>
        <div class="field">
          <label>Branche</label>
          <input type="text" name="gitBranch" class="mono" value="${f.gitBranch}" placeholder="par défaut (main, master…)" spellcheck="false" />
        </div>
      </div>`;
    }
    if (f.source === 'archive') {
      return html`<div class="field" style="margin-top:16px">
        <label>Archive du projet</label>
        <input type="file" id="archive" accept=".zip,.tar,.tar.gz,.tgz" />
        <span class="hint">${file ? `Fichier choisi : ${file.name}` : '.zip, .tar.gz ou .tgz — sans le dossier node_modules.'}</span>
      </div>`;
    }
    return html`<p class="hint" style="margin:16px 0 0">Le dossier sera créé vide : ajoutez vos fichiers dans l’onglet « Fichiers » de l’application.</p>`;
  }

  function saveEnv() {
    try {
      if (editor) envValues = editor.getValue();
    } catch {
      // on garde les dernières valeurs valides
    }
  }

  function render() {
    const isStatic = f.type === 'static';
    const hasPort = f.type !== 'bot';
    setHTML(
      root,
      html`<a class="back" href="#/">${icon('back')} Tableau de bord</a>
        <div class="page-header">
          <div>
            <h1>Nouvelle application</h1>
            <div class="sub">Hébergez un bot Discord ou un site web sur votre Raspberry Pi.</div>
          </div>
        </div>
        <form id="new-app" class="stack" novalidate>
          <div class="card">
            <div class="card-header"><h2>1. Type d'application</h2></div>
            <div class="card-body">
              <div class="choices">
                ${TYPES.map(
                  (t) => html`<button type="button" class="choice ${f.type === t.id ? 'selected' : ''}" data-type="${t.id}">
                    <div class="app-icon ${t.id}">${icon(t.icon)}</div>
                    <div class="t">${t.title}</div>
                    <div class="d">${t.desc}</div>
                  </button>`,
                )}
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-header"><h2>2. Code source</h2></div>
            <div class="card-body">
              <div class="choices">
                ${SOURCES.map(
                  (s) => html`<button type="button" class="choice compact ${f.source === s.id ? 'selected' : ''}" data-source="${s.id}">
                    ${icon(s.icon)} <span class="t">${s.title}</span>
                  </button>`,
                )}
              </div>
              ${sourceDetails()}
            </div>
          </div>

          <div class="card">
            <div class="card-header"><h2>3. Configuration</h2></div>
            <div class="card-body form-grid">
              <div class="field full">
                <label>Nom</label>
                <input type="text" name="name" value="${f.name}" placeholder="${f.type === 'bot' ? 'Mon super bot' : 'Mon site'}" maxlength="60" />
              </div>
              ${isStatic
                ? ''
                : html`<div class="field full">
                    <label>Commande de démarrage</label>
                    <input type="text" name="startCommand" class="mono" value="${f.startCommand}" spellcheck="false" />
                    <span class="hint">Ex. <code>node index.js</code> (plus léger que <code>npm start</code> sur un Pi).</span>
                  </div>`}
              <div class="field">
                <label>Installation des dépendances</label>
                <input type="text" name="installCommand" class="mono" value="${f.installCommand}" spellcheck="false" />
                <span class="hint">Lancée s'il y a un package.json. Laissez vide pour désactiver.</span>
              </div>
              <div class="field">
                <label>Commande de build <span class="faint">(optionnel)</span></label>
                <input type="text" name="buildCommand" class="mono" value="${f.buildCommand}" placeholder="npm run build" spellcheck="false" />
              </div>
              ${isStatic
                ? html`<div class="field">
                      <label>Dossier à servir</label>
                      <input type="text" name="staticDir" class="mono" value="${f.staticDir}" placeholder="." spellcheck="false" />
                      <span class="hint"><code>.</code> pour la racine, <code>dist</code> ou <code>build</code> après un build.</span>
                    </div>
                    <div class="field">
                      <label>&nbsp;</label>
                      <label class="check"><input type="checkbox" name="spa" ${f.spa ? 'checked' : ''} /><span>Application monopage (SPA)<small>Renvoie index.html pour les routes inconnues (React Router, Vue Router…).</small></span></label>
                    </div>`
                : ''}
              ${hasPort
                ? html`<div class="field">
                      <label>Port</label>
                      <input type="number" name="port" value="${f.port}" placeholder="Automatique" min="1024" max="65535" />
                      <span class="hint">Votre code doit écouter sur <code>process.env.PORT</code>.</span>
                    </div>
                    <div class="field">
                      <label>Nom(s) de domaine <span class="faint">(optionnel)</span></label>
                      <input type="text" name="domains" class="mono" value="${f.domains}" placeholder="monsite.fr, www.monsite.fr" spellcheck="false" />
                      <span class="hint">Servi en HTTPS par Caddy (voir Paramètres).</span>
                    </div>`
                : ''}
            </div>
          </div>

          <div class="card">
            <div class="card-header"><h2>4. Variables d'environnement</h2></div>
            <div class="card-body" id="env"></div>
          </div>

          <div class="card">
            <div class="card-body">
              <label class="check"><input type="checkbox" name="autoRestart" ${f.autoRestart ? 'checked' : ''} /><span>Redémarrage automatique<small>Relance l'application si elle plante.</small></span></label>
              ${f.source === 'empty'
                ? ''
                : html`<label class="check"><input type="checkbox" name="start" ${f.start ? 'checked' : ''} /><span>Démarrer après la création<small>Installe les dépendances, lance le build éventuel puis démarre l'application.</small></span></label>`}
              <div class="error-text"></div>
              <div class="progress hidden" id="progress"><i></i></div>
            </div>
            <div class="card-foot">
              <a class="btn btn-ghost" href="#/">Annuler</a>
              <button class="btn btn-primary" type="submit">${icon('check')} Créer l'application</button>
            </div>
          </div>
        </form>`,
    );
    editor = envEditor($('#env', root), envValues);
  }

  render();

  root.addEventListener('click', (e) => {
    const type = e.target.closest('[data-type]');
    const source = e.target.closest('[data-source]');
    if (!type && !source) return;
    saveEnv();
    if (type) f.type = type.dataset.type;
    if (source) f.source = source.dataset.source;
    if (!f.startTouched) f.startCommand = defaultStart(f.type, f.source);
    if (f.type === 'bot' && !('DISCORD_TOKEN' in envValues)) envValues = { DISCORD_TOKEN: '', ...envValues };
    render();
  });

  root.addEventListener('input', (e) => {
    const { name } = e.target;
    if (!name || !(name in f)) return;
    f[name] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (name === 'startCommand') f.startTouched = true;
  });

  root.addEventListener('change', (e) => {
    if (e.target.id === 'archive') file = e.target.files[0] || null;
  });

  root.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const error = $('.error-text', form);
    const button = $('[type=submit]', form);
    error.textContent = '';

    let env;
    try {
      env = editor.getValue();
    } catch (err) {
      error.textContent = err.message;
      return;
    }
    if (!f.name.trim()) error.textContent = 'Donnez un nom à votre application';
    else if (f.source === 'git' && !f.gitUrl.trim()) error.textContent = 'Indiquez l’URL du dépôt Git';
    else if (f.source === 'archive' && !file) error.textContent = 'Choisissez une archive à importer';
    if (error.textContent) return;

    const body = {
      name: f.name,
      type: f.type,
      source: f.source,
      installCommand: f.installCommand,
      buildCommand: f.buildCommand,
      env,
      autoRestart: f.autoRestart,
      start: f.start && f.source !== 'archive',
    };
    if (f.type !== 'static') body.startCommand = f.startCommand;
    if (f.type === 'static') Object.assign(body, { staticDir: f.staticDir, spa: f.spa });
    if (f.type !== 'bot') Object.assign(body, { port: f.port || null, domains: f.domains });
    if (f.source === 'git') body.git = { url: f.gitUrl, branch: f.gitBranch };

    button.disabled = true;
    try {
      const { app, caddy } = await api.post('/apps', body);
      if (caddy && !caddy.ok) toast(`Caddy : ${caddy.error}`, 'err');
      if (f.source === 'archive') {
        const progress = $('#progress', form);
        progress.classList.remove('hidden');
        try {
          await upload(
            `/apps/${app.id}/archive?${qs({ filename: file.name, deploy: '1', start: f.start ? '1' : '0' })}`,
            file,
            (ratio) => {
              progress.firstElementChild.style.width = `${(ratio * 100).toFixed(0)}%`;
            },
          );
        } catch (err) {
          toast(`Application créée, mais l'import de l'archive a échoué : ${err.message}`, 'err');
        }
      }
      toast(`« ${app.name} » a été créée`);
      await refreshApps();
      location.hash = `#/apps/${app.id}`;
    } catch (err) {
      error.textContent = err.message;
      button.disabled = false;
    }
  });
}

import { api, qs, upload } from '../api.js';
import { refreshApps } from '../state.js';
import { envEditor } from '../env-editor.js';
import { openOverlay, stepsAt } from '../overlay.js';
import {
  $,
  filePicker,
  html,
  icon,
  pageHero,
  routingWarnings,
  setHTML,
  tip,
  toast,
  toggle,
} from '../ui.js';

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

// Explication de chaque source (bulle « i » du titre « Code source »)
const SOURCE_INFO = {
  git: html`Le panel clone le dépôt, installe les dépendances puis lance l'application. Dépôt privé : <code>https://&lt;jeton&gt;@github.com/moi/projet.git</code>.`,
  archive: 'Une archive .zip, .tar.gz ou .tgz de votre projet, sans le dossier node_modules. Un ZIP téléchargé depuis GitHub fonctionne tel quel.',
  empty: 'Le dossier sera créé vide : ajoutez ensuite vos fichiers dans l’onglet « Fichiers » de l’application.',
};

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
    startOnBoot: true,
    start: true,
  };
  let file = null;
  let envValues = { DISCORD_TOKEN: '' };
  let editor = null;

  function sourceDetails() {
    if (f.source === 'git') {
      return html`<div class="form-grid" style="margin-top:16px">
        <div class="field">
          <label>URL du dépôt ${tip(html`Dépôt privé : <code>https://&lt;jeton&gt;@github.com/moi/projet.git</code>`)}</label>
          <input type="text" name="gitUrl" class="mono" value="${f.gitUrl}" placeholder="https://github.com/moi/mon-projet.git" spellcheck="false" />
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
        ${filePicker({ id: 'archive', accept: '.zip,.tar,.tar.gz,.tgz', label: 'Choisir une archive…', current: file?.name })}
      </div>`;
    }
    return '';
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
        ${pageHero({ icon: 'plus', tone: 'green', title: 'Nouvelle application', info: 'Hébergez un bot Discord ou un site web (Node.js ou statique) sur votre machine.' })}
        <form id="new-app" class="stack" novalidate>
          <div class="card">
            <div class="card-header"><h2><span class="step-num">1</span> Type d'application</h2></div>
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
            <div class="card-header"><h2><span class="step-num">2</span> Code source ${tip(f.source === 'template' ? TEMPLATE_INFO[f.type] : SOURCE_INFO[f.source])}</h2></div>
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
            <div class="card-header"><h2><span class="step-num">3</span> Configuration</h2></div>
            <div class="card-body form-grid">
              <div class="field full">
                <label>Nom</label>
                <input type="text" name="name" value="${f.name}" placeholder="${f.type === 'bot' ? 'Mon super bot' : 'Mon site'}" maxlength="60" />
              </div>
              ${isStatic
                ? ''
                : html`<div class="field full">
                    <label>Commande de démarrage ${tip(html`Par exemple <code>node index.js</code>, plus léger que <code>npm start</code> (un seul processus au lieu de deux).`)}</label>
                    <input type="text" name="startCommand" class="mono" value="${f.startCommand}" spellcheck="false" />
                  </div>`}
              <div class="field">
                <label>Installation des dépendances ${tip('Lancée s’il y a un package.json. Laissez vide pour la désactiver.')}</label>
                <input type="text" name="installCommand" class="mono" value="${f.installCommand}" spellcheck="false" />
              </div>
              <div class="field">
                <label>Commande de build <span class="faint">(optionnel)</span></label>
                <input type="text" name="buildCommand" class="mono" value="${f.buildCommand}" placeholder="npm run build" spellcheck="false" />
              </div>
              ${isStatic
                ? html`<div class="field">
                      <label>Dossier à servir ${tip(html`<code>.</code> pour la racine, <code>dist</code> ou <code>build</code> après un build.`)}</label>
                      <input type="text" name="staticDir" class="mono" value="${f.staticDir}" placeholder="." spellcheck="false" />
                    </div>
                    <div class="field">
                      <label>&nbsp;</label>
                      <label class="check">${toggle('spa', f.spa)}<span>Application monopage (SPA) ${tip('Renvoie index.html pour les adresses inconnues (React Router, Vue Router…).')}</span></label>
                    </div>`
                : ''}
              ${hasPort
                ? html`<div class="field">
                      <label>Port ${tip(html`Votre code doit écouter sur <code>process.env.PORT</code>. Laissez vide : le panel en choisit un libre.`)}</label>
                      <input type="number" name="port" value="${f.port}" placeholder="Automatique" min="1024" max="65535" />
                    </div>
                    <div class="field">
                      <label>Nom(s) de domaine <span class="faint">(optionnel)</span> ${tip('Publié en HTTPS par le tunnel Cloudflare (Paramètres → Tunnel Cloudflare). Plusieurs domaines : séparez-les par des virgules.')}</label>
                      <input type="text" name="domains" class="mono" value="${f.domains}" placeholder="monsite.fr, www.monsite.fr" spellcheck="false" />
                    </div>`
                : ''}
            </div>
          </div>

          <div class="card">
            <div class="card-header"><h2><span class="step-num">4</span> Variables d'environnement ${tip(html`Lues par votre code avec <code>process.env.NOM</code>. Gardez-y vos secrets (token Discord, clés d'API) plutôt que dans le code.`)}</h2></div>
            <div class="card-body" id="env"></div>
          </div>

          <div class="card">
            <div class="card-body">
              <label class="check">${toggle('autoRestart', f.autoRestart)}<span>Redémarrage automatique ${tip('Relance l’application si elle plante.')}</span></label>
              <label class="check">${toggle('startOnBoot', f.startOnBoot)}<span>Démarrer avec la machine ${tip('Lance l’application à chaque démarrage de la machine.')}</span></label>
              ${f.source === 'empty'
                ? ''
                : html`<label class="check">${toggle('start', f.start)}<span>Démarrer après la création ${tip('Installe les dépendances, lance le build éventuel puis démarre l’application.')}</span></label>`}
              <div class="error-text"></div>
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
      startOnBoot: f.startOnBoot,
      start: f.start && f.source !== 'archive',
    };
    if (f.type !== 'static') body.startCommand = f.startCommand;
    if (f.type === 'static') Object.assign(body, { staticDir: f.staticDir, spa: f.spa });
    if (f.type !== 'bot') Object.assign(body, { port: f.port || null, domains: f.domains });
    if (f.source === 'git') body.git = { url: f.gitUrl, branch: f.gitBranch };

    button.disabled = true;
    // écran flouté pendant la création ; il disparaît une fois l'application ouverte
    const labels = ['Création de l’application', ...(f.source === 'archive' ? ['Envoi de l’archive'] : []), 'Ouverture de l’application'];
    const screen = openOverlay('Création de l’application');
    const typeLabel = TYPES.find((t) => t.id === f.type)?.title || '';
    const show = (index, percent, detail) =>
      screen.render({ title: 'Création de l’application', subtitle: html`<b>${f.name.trim()}</b> · ${typeLabel}`, percent, detail, steps: stepsAt(labels, index) });
    show(0, 15, 'Création du dossier et de la configuration…');
    try {
      const { app, ...routing } = await api.post('/apps', body);
      routingWarnings(routing);
      if (f.source === 'archive') {
        show(1, 30, `Envoi de l’archive « ${file.name} » : 0 %`);
        try {
          await upload(
            `/apps/${app.id}/archive?${qs({ filename: file.name, deploy: '1', start: f.start ? '1' : '0' })}`,
            file,
            (ratio) => show(1, 30 + ratio * 55, `Envoi de l’archive « ${file.name} » : ${Math.round(ratio * 100)} %`),
          );
        } catch (err) {
          toast(`Application créée, mais l'import de l'archive a échoué : ${err.message}`, 'err');
        }
      }
      const deploying = f.source === 'git' || f.source === 'template' || f.source === 'archive';
      show(labels.length - 1, 100, deploying ? 'Ouverture de l’application : l’installation se poursuit dans sa console…' : 'Ouverture de l’application…');
      await refreshApps();
      // l'écran reste visible un court instant (pas de clignotement), puis l'application s'ouvre et l'écran disparaît
      await new Promise((r) => setTimeout(r, Math.max(0, 700 - (Date.now() - screen.startedAt))));
      location.hash = `#/apps/${app.id}/console`; // suivre l'installation dans la console
      toast(`« ${app.name} » a été créée`);
      setTimeout(() => screen.close(), 250);
    } catch (err) {
      screen.close();
      error.textContent = err.message;
      button.disabled = false;
    }
  });
}

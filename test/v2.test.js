import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { startTestPanel, waitFor } from './helpers.js';
import { Metrics } from '../src/metrics.js';
import { Store } from '../src/store.js';
import { parseTunnelToken, hostnameOf } from '../src/tunnel.js';
import { Updater, parseGithub } from '../src/update.js';
import { LATEST_BRANCH, compareVersions, nextVersion, parseVersionBranch, versionBranch } from '../src/version.js';
import { niceTicks } from '../public/js/chart.js';

test('historique : agrégation par palier et conservation limitée', () => {
  const m = new Metrics(path.join(mkdtempSync(path.join(os.tmpdir(), 'astra-metrics-')), 'metrics.json'));
  const t0 = Math.floor(Date.now() / 60_000) * 60_000 - 30 * 60_000; // aligné sur la minute, il y a 30 min
  m.add({ cpu: 10, temp: 50, mem: 1000 }, t0);
  m.add({ cpu: 30, temp: null, mem: 3000 }, t0 + 5000);
  m.add({ cpu: 50, temp: 60, mem: 2000 }, t0 + 15_000); // nouvel intervalle de 10 s
  const h = m.query('1h');
  assert.equal(h.step, 10_000);
  assert.deepEqual(h.points[0], [t0, 20, 50, 2000]); // moyenne, la température absente est ignorée
  assert.deepEqual(h.points[1], [t0 + 10_000, 50, 60, 2000]); // intervalle en cours
  assert.equal(m.query('24h').points.length, 1);
  m.add({ cpu: 1, temp: 1, mem: 1 }, t0 + 2 * 3600_000); // deux heures plus tard
  assert.ok(m.query('1h').points.every((p) => p[0] >= t0 + 3600_000));
  assert.equal(m.query('7j'), null);
  m.save();
  const reloaded = new Metrics(m.file);
  assert.ok(reloaded.query('24h').points.length >= 1);
  assert.equal(reloaded.query('1h').points.length, 0); // le palier 1h n'est pas écrit sur la carte SD
});

test('graduations rondes', () => {
  assert.deepEqual(niceTicks(0, 100, 4), [0, 25, 50, 75, 100]);
  assert.deepEqual(niceTicks(0, 15.7, 4), [0, 5, 10, 15]);
  assert.deepEqual(niceTicks(30, 70, 4), [30, 40, 50, 60, 70]);
});

test('jeton de tunnel Cloudflare', () => {
  const token = Buffer.from(JSON.stringify({ a: 'acc', t: 'tun-id', s: 'secret' })).toString('base64');
  assert.deepEqual(parseTunnelToken(`sudo cloudflared service install ${token}`), { token, accountId: 'acc', tunnelId: 'tun-id' });
  assert.throws(() => parseTunnelToken('rien'), { status: 400 });
  assert.throws(() => parseTunnelToken(`eyJ${'a'.repeat(30)}`), { status: 400 });
  assert.equal(hostnameOf('http://site.local:8080'), 'site.local');
  assert.equal(hostnameOf('monsite.fr'), 'monsite.fr');
});

test('versions : +0.0.1 avec retenue et branches AstraPanel-V.X.Y.Z', () => {
  assert.equal(nextVersion('1.2.8'), '1.2.9');
  assert.equal(nextVersion('1.2.9'), '1.3.0');
  assert.equal(nextVersion('1.3.0'), '1.3.1');
  assert.equal(nextVersion('1.9.9'), '2.0.0');
  assert.throws(() => nextVersion('1.2'));
  assert.ok(compareVersions('1.3.0', '1.2.9') > 0);
  assert.ok(compareVersions('1.2.10', '1.2.9') > 0); // comparaison numérique, pas alphabétique
  assert.equal(compareVersions('1.2.2', '1.2.2'), 0);
  assert.equal(LATEST_BRANCH, 'AstraPanel-Latest');
  assert.equal(versionBranch('1.3.0'), 'AstraPanel-V.1.3.0');
  assert.equal(parseVersionBranch('AstraPanel-V.1.3.0'), '1.3.0');
  assert.equal(parseVersionBranch('AstraPanel-version.1.3.0-latest'), null);
});

const gitIn = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' }).trim();

function publishLocal(repo, version) {
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'astrapanel', version }, null, 2) + '\n');
  gitIn(repo, 'add', 'package.json');
  gitIn(repo, 'commit', '-qm', `Version ${version}`);
  return gitIn(repo, 'rev-parse', 'HEAD');
}

test('mises à jour : le panel lit la version publiée sur AstraPanel-Latest', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'astra-update-'));
  const repo = path.join(tmp, 'depot');
  mkdirSync(repo);
  gitIn(repo, 'init', '-q', '-b', LATEST_BRANCH);
  const first = publishLocal(repo, '1.2.2');
  const root = path.join(tmp, 'install');
  mkdirSync(root);
  writeFileSync(path.join(root, 'version.json'), JSON.stringify({ repo, commit: first, installedAt: 1 }));
  const config = { root, dataDir: path.join(tmp, 'data'), version: '1.2.2' };
  mkdirSync(config.dataDir);
  const updater = new Updater({ store: { data: { settings: {} } }, config });

  let st = await updater.check();
  assert.equal(st.error, null);
  assert.equal(st.branch, 'AstraPanel-Latest');
  assert.equal(st.latestVersion, '1.2.2');
  assert.equal(st.available, false); // même version : rien à proposer
  assert.equal(existsSync(updater.cacheDir), false); // le téléchargement temporaire est supprimé

  const second = publishLocal(repo, '1.2.3');
  const [a, b] = [updater.check(), updater.check()]; // vérifications simultanées : une seule à la fois
  assert.equal(a, b);
  st = await a;
  assert.equal(st.latestVersion, '1.2.3');
  assert.equal(st.latestCommit, second);
  assert.equal(st.available, true);
  assert.equal(st.checking, false); // la réponse arrive une fois la vérification terminée
  assert.equal(st.installed.version, '1.2.2');

  config.version = '1.2.3'; // après la mise à jour
  assert.equal((await updater.status()).available, false);

  // une branche qui ne s'appelle pas AstraPanel-Latest n'est pas suivie
  gitIn(repo, 'branch', '-m', LATEST_BRANCH, 'main');
  st = await updater.check();
  assert.match(st.error, /AstraPanel-Latest/);
});

test('publication : nouvelle-version.sh pousse AstraPanel-Latest et AstraPanel-V.X.Y.Z', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'astra-release-'));
  const remote = path.join(tmp, 'remote.git');
  gitIn(tmp, 'init', '-q', '--bare', remote);
  const work = path.join(tmp, 'work');
  mkdirSync(path.join(work, 'scripts'), { recursive: true });
  mkdirSync(path.join(work, 'src'));
  copyFileSync(new URL('../scripts/nouvelle-version.sh', import.meta.url), path.join(work, 'scripts/nouvelle-version.sh'));
  copyFileSync(new URL('../src/version.js', import.meta.url), path.join(work, 'src/version.js'));
  gitIn(work, 'init', '-q', '-b', 'dev');
  gitIn(work, 'remote', 'add', 'origin', remote);
  publishLocal(work, '1.2.8');
  gitIn(work, 'add', '.');
  gitIn(work, 'commit', '-qm', 'Projet');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' };
  const release = () => execFileSync('bash', ['scripts/nouvelle-version.sh'], { cwd: work, env, encoding: 'utf8', stdio: 'pipe' });
  const remoteVersion = (branch) => JSON.parse(gitIn(remote, 'show', `${branch}:package.json`)).version;
  const heads = () => gitIn(remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').sort();

  release(); // première publication : 1.2.8 → 1.2.9
  assert.deepEqual(heads(), ['AstraPanel-Latest', 'AstraPanel-V.1.2.9']);
  assert.equal(remoteVersion('AstraPanel-Latest'), '1.2.9');
  assert.equal(gitIn(remote, 'rev-parse', 'AstraPanel-Latest'), gitIn(remote, 'rev-parse', 'AstraPanel-V.1.2.9'));

  writeFileSync(path.join(work, 'nouveau.txt'), 'changement');
  gitIn(work, 'add', '.');
  gitIn(work, 'commit', '-qm', 'Changement');
  release(); // 1.2.9 → 1.3.0, avec les mêmes fichiers sur les deux branches
  assert.deepEqual(heads(), ['AstraPanel-Latest', 'AstraPanel-V.1.2.9', 'AstraPanel-V.1.3.0']);
  assert.equal(remoteVersion('AstraPanel-Latest'), '1.3.0');
  assert.equal(remoteVersion('AstraPanel-V.1.2.9'), '1.2.9'); // l'ancienne version reste intacte
  assert.equal(gitIn(remote, 'show', 'AstraPanel-V.1.3.0:nouveau.txt'), 'changement');

  // une branche de version renommée à la main plus haut que AstraPanel-Latest : la numérotation la suit
  gitIn(work, 'push', '-q', 'origin', 'HEAD:refs/heads/AstraPanel-V.1.3.5');
  writeFileSync(path.join(work, 'autre.txt'), 'encore');
  gitIn(work, 'add', '.');
  gitIn(work, 'commit', '-qm', 'Autre changement');
  release();
  assert.equal(remoteVersion('AstraPanel-Latest'), '1.3.6');

  // des modifications non commitées bloquent la publication
  writeFileSync(path.join(work, 'brouillon.txt'), 'x');
  assert.throws(release, /pas commitées/);
});

test('publication : AstraPanel-Latest sans package.json (ancien main) et versions déjà renommées', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'astra-release2-'));
  const remote = path.join(tmp, 'remote.git');
  gitIn(tmp, 'init', '-q', '--bare', remote);
  const work = path.join(tmp, 'work');
  mkdirSync(path.join(work, 'scripts'), { recursive: true });
  mkdirSync(path.join(work, 'src'));
  gitIn(work, 'init', '-q', '-b', 'dev');
  gitIn(work, 'remote', 'add', 'origin', remote);
  writeFileSync(path.join(work, 'README.md'), '# AstraPanel');
  gitIn(work, 'add', '.');
  gitIn(work, 'commit', '-qm', 'README initial');
  gitIn(work, 'push', '-q', 'origin', 'HEAD:refs/heads/AstraPanel-Latest'); // l'ancien main renommé
  copyFileSync(new URL('../scripts/nouvelle-version.sh', import.meta.url), path.join(work, 'scripts/nouvelle-version.sh'));
  copyFileSync(new URL('../src/version.js', import.meta.url), path.join(work, 'src/version.js'));
  publishLocal(work, '1.2.1');
  gitIn(work, 'add', '.');
  gitIn(work, 'commit', '-qm', 'Panel');
  gitIn(work, 'push', '-q', 'origin', 'HEAD:refs/heads/AstraPanel-V.1.2.2'); // anciennes branches renommées
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' };
  const out = execFileSync('bash', ['scripts/nouvelle-version.sh'], { cwd: work, env, encoding: 'utf8', stdio: 'pipe' });
  assert.match(out, /1\.2\.2 → nouvelle version : 1\.2\.3/);
  assert.equal(JSON.parse(gitIn(remote, 'show', 'AstraPanel-Latest:package.json')).version, '1.2.3');
  assert.equal(gitIn(remote, 'rev-parse', 'AstraPanel-Latest'), gitIn(remote, 'rev-parse', 'AstraPanel-V.1.2.3'));
});

test('journal d’activité : qui a fait quoi, sans aucun secret', async (t) => {
  const ctx = await startTestPanel();
  t.after(() => ctx.close());
  await ctx.setupAdmin();
  const adminCookie = ctx.getCookie();
  await ctx.request('POST', '/api/users', { body: { username: 'alice', password: 'motdepasse-alice', role: 'user' } });

  ctx.setCookie('');
  assert.equal((await ctx.request('POST', '/api/auth/login', { body: { username: 'alice', password: 'faux' } })).status, 401);
  await ctx.request('POST', '/api/auth/login', { body: { username: 'alice', password: 'motdepasse-alice' } });
  assert.equal((await ctx.request('GET', '/api/audit')).status, 403); // réservé aux administrateurs
  const { app } = (await ctx.request('POST', '/api/apps', { body: { name: 'Blog', type: 'static', source: 'empty' } })).data;
  await ctx.request('PUT', `/api/apps/${app.id}/files/content`, { body: { path: 'index.html', content: 'contenu-prive' } });
  await ctx.request('PATCH', `/api/apps/${app.id}`, { body: { env: { DISCORD_TOKEN: 'valeur-secrete' }, domains: ['blog.exemple.fr'] } });
  assert.equal((await ctx.request('POST', `/api/apps/${app.id}/files/mkdir`, { body: { path: '../hors' } })).status, 400); // échec : non journalisé

  ctx.setCookie(adminCookie);
  await ctx.request('DELETE', `/api/apps/${app.id}`);
  const { data } = await ctx.request('GET', '/api/audit');
  const lines = data.entries.map((e) => `${e.user?.username || '—'} | ${e.label} | ${e.app?.name || ''} | ${e.detail || ''}`);
  assert.deepEqual(lines.slice(0, 6), [
    'admin | Suppression de l’application | Blog | ', // le nom reste lisible après la suppression
    'alice | Modification des paramètres | Blog | domaines : blog.exemple.fr · variables : DISCORD_TOKEN',
    'alice | Fichier enregistré | Blog | index.html',
    'alice | Création de l’application | Blog | site statique',
    'alice | Connexion |  | ',
    '— | Échec de connexion |  | nom saisi : alice',
  ]);
  const raw = readFileSync(path.join(ctx.cfg.dataDir, 'audit.log'), 'utf8');
  for (const secret of ['valeur-secrete', 'motdepasse', 'contenu-prive', '"faux"']) assert.ok(!raw.includes(secret), secret);

  // filtres : par compte, par appli, par recherche
  const alice = data.users.find((u) => u.username === 'alice');
  const byAlice = (await ctx.request('GET', `/api/audit?user=${alice.id}`)).data.entries;
  assert.ok(byAlice.length >= 4 && byAlice.every((e) => e.user.id === alice.id));
  assert.equal((await ctx.request('GET', `/api/audit?app=${app.id}`)).data.entries.length, 4);
  assert.equal((await ctx.request('GET', '/api/audit?q=index.html')).data.entries.length, 1);
  assert.equal((await ctx.request('GET', '/api/audit?user=-')).data.entries[0].label, 'Échec de connexion');
  assert.equal((await ctx.request('GET', '/api/audit?limit=2')).data.more, true);
});

test('Hardware : redémarrage demandé au service root, avec validation', async (t) => {
  const unit = path.join(mkdtempSync(path.join(os.tmpdir(), 'astra-unit-')), 'astrapanel-reboot.path');
  process.env.ASTRA_REBOOT_UNIT = unit;
  process.env.ASTRA_REBOOT_DELAY = '0'; // demande écrite tout de suite (8 s plus tard en temps normal)
  t.after(() => {
    delete process.env.ASTRA_REBOOT_UNIT;
    delete process.env.ASTRA_REBOOT_DELAY;
  });
  const ctx = await startTestPanel();
  t.after(() => ctx.close());
  await ctx.setupAdmin();
  const request = path.join(ctx.cfg.dataDir, 'reboot-request');

  let res = await ctx.request('GET', '/api/hardware');
  assert.equal(res.status, 200);
  assert.ok(res.data.model && res.data.cpus > 0 && res.data.memory.total > 0);
  assert.equal(res.data.reboot.available, false);
  assert.equal((await ctx.request('POST', '/api/hardware/reboot', { body: { confirm: true } })).status, 400); // service absent

  writeFileSync(unit, '');
  assert.equal((await ctx.request('POST', '/api/hardware/reboot', { body: {} })).status, 400); // pas validé
  assert.equal(existsSync(request), false);
  assert.equal((await ctx.request('POST', '/api/hardware/reboot', { body: { confirm: true } })).status, 200);
  const sent = JSON.parse(readFileSync(request, 'utf8'));
  assert.equal(sent.by, 'admin');
  assert.equal(sent.bootId, readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()); // lu par deploy/reboot.sh
  assert.equal((await ctx.request('POST', '/api/hardware/reboot', { body: { confirm: true } })).status, 409);
  assert.equal((await ctx.request('GET', '/api/audit')).data.entries[0].label, 'Redémarrage de la machine');
  // l'écran d'attente de tous les comptes voit le redémarrage demandé et le démarrage en cours (pour détecter le retour)
  const progress = (await ctx.request('GET', '/api/update/progress')).data;
  assert.equal(progress.reboot.by, 'admin');
  assert.equal(progress.bootId, sent.bootId);

  await ctx.request('POST', '/api/users', { body: { username: 'bob', password: 'motdepasse123', role: 'user' } });
  ctx.setCookie('');
  await ctx.request('POST', '/api/auth/login', { body: { username: 'bob', password: 'motdepasse123' } });
  assert.equal((await ctx.request('GET', '/api/hardware')).status, 403);
  assert.equal((await ctx.request('POST', '/api/hardware/reboot', { body: { confirm: true } })).status, 403);
  assert.equal((await ctx.request('GET', '/api/update/progress')).data.reboot.by, 'admin'); // un simple utilisateur le voit aussi
});

test('mise à jour en cours : progression lisible par tous les comptes', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'astra-progress-'));
  process.env.ASTRA_UPDATE_STATUS = path.join(dir, 'update-status.json');
  process.env.ASTRA_UPDATE_LOG = path.join(dir, 'update.log');
  t.after(() => {
    delete process.env.ASTRA_UPDATE_STATUS;
    delete process.env.ASTRA_UPDATE_LOG;
  });
  const ctx = await startTestPanel();
  t.after(() => ctx.close());
  await ctx.setupAdmin();
  await ctx.request('POST', '/api/users', { body: { username: 'bob', password: 'motdepasse123', role: 'user' } });
  ctx.setCookie('');
  await ctx.request('POST', '/api/auth/login', { body: { username: 'bob', password: 'motdepasse123' } });
  const progress = async () => (await ctx.request('GET', '/api/update/progress')).data;

  assert.equal((await progress()).active, false); // aucune mise à jour

  // demande déposée, service pas encore lancé
  const request = path.join(ctx.cfg.dataDir, 'update-request');
  writeFileSync(request, '{}');
  assert.deepEqual([(await progress()).active, (await progress()).pending], [true, true]);
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(request, old, old); // demande jamais prise en charge : plus affichée
  assert.equal((await progress()).active, false);
  rmSync(request);

  // installation en cours : étape lue dans le journal (couleurs retirées), version visée
  writeFileSync(process.env.ASTRA_UPDATE_STATUS, JSON.stringify({ state: 'running', message: 'Installation de la nouvelle version…', version: '9.9.9', at: Date.now() }));
  writeFileSync(process.env.ASTRA_UPDATE_LOG, '==> Mise à jour depuis la branche « AstraPanel-Latest »\nnpm notice\n\u001b[1;35m==>\u001b[0m Copie du panel dans /opt/astrapanel…\nautre ligne\n');
  let p = await progress();
  assert.equal(p.active, true);
  assert.equal(p.step, 'Copie du panel dans /opt/astrapanel…');
  assert.equal(p.target, '9.9.9');
  assert.equal(p.log, undefined); // pas le journal complet pour un simple utilisateur

  // terminée : plus « en cours », mais l'état reste lisible quelques minutes
  writeFileSync(process.env.ASTRA_UPDATE_STATUS, JSON.stringify({ state: 'done', message: 'Mise à jour terminée', version: '9.9.9', at: Date.now() }));
  p = await progress();
  assert.deepEqual([p.active, p.state], [false, 'done']);
  // une mise à jour vieille d'une heure est ignorée
  writeFileSync(process.env.ASTRA_UPDATE_STATUS, JSON.stringify({ state: 'running', message: 'x', at: Date.now() - 3600_000 }));
  p = await progress();
  assert.deepEqual([p.active, p.state, p.step], [false, null, null]);
});

test('port du panel : ASTRA_PORT, sinon PORT (panel hébergé dans un autre panel), sinon 8080', () => {
  const portWith = (extra) => {
    const env = { ...process.env, ...extra };
    for (const key of ['ASTRA_PORT', 'PORT']) if (!(key in extra)) delete env[key];
    return execFileSync(process.execPath, ['--input-type=module', '-e', "import('./src/config.js').then((m) => console.log(m.config.port))"], { env, encoding: 'utf8' }).trim();
  };
  assert.equal(portWith({}), '8080');
  assert.equal(portWith({ PORT: '8999' }), '8999');
  assert.equal(portWith({ ASTRA_PORT: '8080', PORT: '8999' }), '8080'); // le service systemd fixe toujours ASTRA_PORT
});

test('ports occupés : le panel dit qui occupe le port et arrête un ancien processus de la même appli', async (t) => {
  const ctx = await startTestPanel();
  const holders = [];
  t.after(async () => {
    for (const h of holders) {
      try {
        process.kill(-h.pid, 'SIGKILL');
      } catch {
        // déjà arrêté
      }
    }
    await ctx.close();
  });
  await ctx.setupAdmin();
  // un serveur « extérieur » qui occupe un port, lancé depuis le dossier voulu
  const occupy = (port, cwd) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${port}, () => console.log('pret'))`], { cwd, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
      holders.push(child);
      child.stdout.once('data', () => resolve(child));
    });
  const listen = (port) => `node -e "require('http').createServer((q, r) => r.end('ok')).listen(${port})"`;
  const logText = async (id) => ctx.panel.apps.logsFor(id).lines.map((l) => l.m).join('\n');
  const isFree = (port) => new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(port, () => s.close(() => r(true))); });
  const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => r(port)); }); });

  const { app } = (await ctx.request('POST', '/api/apps', { body: { name: 'Site', type: 'node', source: 'empty', startCommand: listen('process.env.PORT') } })).data;
  const port = app.port;

  // 1. un autre programme occupe le port : refus clair, l'appli ne démarre pas
  const outsider = await occupy(port, os.tmpdir());
  let res = await ctx.request('POST', `/api/apps/${app.id}/start`);
  assert.equal(res.status, 409);
  assert.match(res.data.error, new RegExp(`Le port ${port} est déjà utilisé par un autre programme \\(PID ${outsider.pid} : .*node -e`));
  process.kill(-outsider.pid, 'SIGKILL');
  await waitFor(() => isFree(port));

  // 2. un ancien processus de la même appli (lancé depuis son dossier) : arrêté, puis l'appli démarre
  const leftover = await occupy(port, path.join(ctx.cfg.appsDir, app.id));
  res = await ctx.request('POST', `/api/apps/${app.id}/start`);
  assert.equal(res.status, 200);
  assert.match(await logText(app.id), new RegExp(`ancienne instance de l’application occupe encore le port ${port} \\(PID ${leftover.pid}\\)`));
  await waitFor(async () => (await ctx.request('GET', `/api/apps/${app.id}`)).data.runtime.status === 'running');
  assert.throws(() => process.kill(leftover.pid, 0)); // l'ancien processus a bien été arrêté
  await ctx.request('POST', `/api/apps/${app.id}/stop`);

  // 3. code qui écoute sur un port en dur (déjà pris) au lieu de PORT : le plantage est expliqué
  const busyPort = await freePort();
  const busy = { port: busyPort, child: await occupy(busyPort, os.tmpdir()) };
  const { app: bad } = (await ctx.request('POST', '/api/apps', { body: { name: 'Port en dur', type: 'node', source: 'empty', startCommand: listen(busy.port), autoRestart: false } })).data;
  await ctx.request('POST', `/api/apps/${bad.id}/start`);
  await waitFor(async () => /Votre code écoute sur le port/.test(await logText(bad.id)));
  const text = await logText(bad.id);
  assert.match(text, new RegExp(`Le port ${busy.port} est déjà utilisé par un autre programme \\(PID ${busy.child.pid}`));
  assert.match(text, new RegExp(`Votre code écoute sur le port ${busy.port}, alors que le panel lui a attribué le port ${bad.port}`));
});

test('applications : pas d’AstraPanel dans le panel, et rien ne reste en arrière-plan', async (t) => {
  const ctx = await startTestPanel();
  const extra = [];
  t.after(async () => {
    for (const pid of extra) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // déjà arrêté
      }
    }
    await ctx.close();
  });
  await ctx.setupAdmin();
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const logText = (id) => ctx.panel.apps.logsFor(id).lines.map((l) => l.m).join('\n');
  const create = async (body) => (await ctx.request('POST', '/api/apps', { body: { type: 'node', source: 'empty', autoRestart: false, ...body } })).data.app;

  // 1. une copie d'AstraPanel ne peut pas être lancée comme application
  const panel = await create({ name: 'Panel de test', startCommand: 'npm start' });
  writeFileSync(path.join(ctx.cfg.appsDir, panel.id, 'package.json'), JSON.stringify({ name: 'astrapanel', version: '1.2.9' }));
  let res = await ctx.request('POST', `/api/apps/${panel.id}/start`);
  assert.equal(res.status, 409);
  assert.match(res.data.error, /contient AstraPanel lui-même/);
  assert.equal((await ctx.request('GET', `/api/apps/${panel.id}`)).data.desired, 'stopped');
  // … y compris cloné dans un sous-dossier
  const nested = await create({ name: 'Clone', startCommand: 'cd AstraPanel && npm start' });
  mkdirSync(path.join(ctx.cfg.appsDir, nested.id, 'AstraPanel', 'src', 'apps'), { recursive: true });
  writeFileSync(path.join(ctx.cfg.appsDir, nested.id, 'AstraPanel', 'src', 'server.js'), '');
  writeFileSync(path.join(ctx.cfg.appsDir, nested.id, 'AstraPanel', 'src', 'apps', 'manager.js'), '');
  assert.equal((await ctx.request('POST', `/api/apps/${nested.id}/start`)).status, 409);

  // 2. une commande qui laisse le vrai programme en arrière-plan : affichée plantée, et le programme est arrêté
  const bg = await create({
    name: 'Arrière-plan',
    // le programme se détache (nouvelle session) puis la commande se termine, comme avec nohup, pm2…
    startCommand: `setsid node -e "setInterval(() => {}, 1000)" & sleep 1`,
  });
  await ctx.request('POST', `/api/apps/${bg.id}/start`);
  await waitFor(() => /lancé un programme en arrière-plan/.test(logText(bg.id)));
  const bgPid = Number(/Processus resté en arrière-plan arrêté \(PID (\d+) : node -e/.exec(logText(bg.id))?.[1]);
  assert.ok(bgPid > 0);
  extra.push(bgPid);
  await waitFor(() => !alive(bgPid));
  assert.notEqual((await ctx.request('GET', `/api/apps/${bg.id}`)).data.runtime.status, 'running');

  // 3. au démarrage du panel, un ancien processus d'une appli (non suivi) est arrêté
  const old = await create({ name: 'Ancienne', startCommand: 'node index.js' });
  // lancé par un shell qui se termine aussitôt : comme un vrai processus orphelin, il n'a plus de parent connu
  const leftoverPid = Number(
    execFileSync('/bin/sh', ['-c', `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)" >/dev/null 2>&1 & echo $!`], { cwd: path.join(ctx.cfg.appsDir, old.id), encoding: 'utf8' }).trim(),
  );
  extra.push(leftoverPid);
  await waitFor(() => alive(leftoverPid));
  await ctx.panel.apps.bootstrap();
  await waitFor(() => !alive(leftoverPid));
  assert.match(logText(old.id), new RegExp(`Processus resté en arrière-plan arrêté \\(PID ${leftoverPid}`));
});

test('interface versionnée et cache vidé après une mise à jour', async (t) => {
  const ctx = await startTestPanel();
  t.after(() => ctx.close());
  const version = ctx.cfg.version;

  // index.html : jamais en cache, fichiers appelés avec la version
  let res = await fetch(`${ctx.base}/`);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const page = await res.text();
  assert.ok(page.includes(`/js/main.js?v=${version}`) && page.includes(`/css/style.css?v=${version}`));
  assert.ok(page.includes(`<meta name="astra-version" content="${version}" />`));
  assert.ok(!page.includes('__ASTRA_VERSION__'));

  // modules : imports relatifs versionnés, revalidation par ETag
  res = await fetch(`${ctx.base}/js/main.js?v=${version}`);
  const main = await res.text();
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.ok(main.includes(`from './ui.js?v=${version}'`) && main.includes(`from './pages/settings.js?v=${version}'`));
  assert.ok(!/from '\.\.?\/[^']+\.js'/.test(main)); // aucun import sans version
  const settingsJs = await (await fetch(`${ctx.base}/js/pages/settings.js`)).text();
  assert.ok(settingsJs.includes(`from '../ui.js?v=${version}'`));
  res = await fetch(`${ctx.base}/js/main.js`, { headers: { 'If-None-Match': res.headers.get('etag') } });
  assert.equal(res.status, 304);
  assert.equal((await fetch(`${ctx.base}/css/style.css`)).status, 200); // autres fichiers : inchangés

  // vidage du cache : réservé aux comptes connectés, avec Clear-Site-Data et la liste des fichiers
  assert.equal((await ctx.request('POST', '/api/cache/clear')).status, 401);
  await ctx.setupAdmin();
  res = await ctx.request('POST', '/api/cache/clear');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('clear-site-data'), '"cache"');
  assert.equal(res.data.version, version);
  for (const asset of ['/', '/js/main.js', '/js/pages/app.js', '/css/style.css', '/favicon.svg']) assert.ok(res.data.assets.includes(asset), asset);
});

test('analyse des URL GitHub', () => {
  assert.deepEqual(parseGithub('https://github.com/moi/AstraPanel.git'), { owner: 'moi', repo: 'AstraPanel', token: null });
  assert.deepEqual(parseGithub('https://ghp_x@github.com/moi/AstraPanel'), { owner: 'moi', repo: 'AstraPanel', token: 'ghp_x' });
  assert.deepEqual(parseGithub('git@github.com:moi/bot.git'), { owner: 'moi', repo: 'bot', token: null });
  assert.equal(parseGithub('https://gitlab.com/moi/bot.git'), null);
});

test('grades : un UTILISATEUR gère ses applis mais pas le panel', async (t) => {
  const ctx = await startTestPanel();
  t.after(() => ctx.close());
  await ctx.setupAdmin();
  const adminCookie = ctx.getCookie();
  let res = await ctx.request('POST', '/api/users', { body: { username: 'alice', password: 'motdepasse123', role: 'user' } });
  assert.equal(res.data.role, 'user');

  ctx.setCookie('');
  res = await ctx.request('POST', '/api/auth/login', { body: { username: 'alice', password: 'motdepasse123' } });
  assert.equal(res.data.user.role, 'user');
  for (const url of ['/api/settings', '/api/users', '/api/storage', '/api/update', '/api/tunnel']) {
    assert.equal((await ctx.request('GET', url)).status, 403, url);
  }
  assert.equal((await ctx.request('GET', '/api/system/metrics?range=24h')).status, 200);
  const { data: mine } = await ctx.request('POST', '/api/apps', { body: { name: 'Site', type: 'static', source: 'empty' } });
  assert.equal((await ctx.request('PUT', `/api/apps/${mine.app.id}/files/content`, { body: { path: 'a.txt', content: 'x' } })).status, 200);
  assert.equal((await ctx.request('DELETE', `/api/apps/${mine.app.id}`)).status, 403); // suppression réservée aux admins

  ctx.setCookie(adminCookie);
  const users = (await ctx.request('GET', '/api/users')).data;
  const admin = users.find((u) => u.username === 'admin');
  res = await ctx.request('PATCH', `/api/users/${admin.id}`, { body: { role: 'user' } });
  assert.equal(res.status, 400); // dernier administrateur
  const alice = users.find((u) => u.username === 'alice');
  res = await ctx.request('PATCH', `/api/users/${alice.id}`, { body: { role: 'admin' } });
  assert.equal(res.data.role, 'admin');
  res = await ctx.request('PATCH', `/api/users/${admin.id}`, { body: { role: 'user' } });
  assert.equal(res.data.role, 'user'); // possible maintenant qu'alice est admin
});

test('accès par application : créateur figé, membres, administrateurs', async (t) => {
  const ctx = await startTestPanel();
  t.after(() => ctx.close());
  await ctx.setupAdmin();
  const cookies = { admin: ctx.getCookie() };
  const ids = {};
  for (const [username, role] of [['alice', 'user'], ['bob', 'user'], ['carol', 'admin']]) {
    ids[username] = (await ctx.request('POST', '/api/users', { body: { username, password: 'motdepasse123', role } })).data.id;
  }
  const as = async (who) => {
    if (!cookies[who]) {
      ctx.setCookie('');
      await ctx.request('POST', '/api/auth/login', { body: { username: who, password: 'motdepasse123' } });
      cookies[who] = ctx.getCookie();
    }
    ctx.setCookie(cookies[who]);
  };
  const names = async () => (await ctx.request('GET', '/api/apps')).data.map((a) => a.name).sort();

  await as('admin');
  const appA = (await ctx.request('POST', '/api/apps', { body: { name: 'A', type: 'static', source: 'empty' } })).data.app.id;

  // alice ne voit pas l'appli de l'admin : elle n'existe pas pour elle (404, jamais 403)
  await as('alice');
  assert.deepEqual(await names(), []);
  for (const [method, url] of [['GET', `/api/apps/${appA}`], ['GET', `/api/apps/${appA}/files?path=`], ['GET', `/api/apps/${appA}/members`], ['POST', `/api/apps/${appA}/start`], ['GET', `/api/apps/${appA}/logs/download`]]) {
    assert.equal((await ctx.request(method, url)).status, 404, `${method} ${url}`);
  }

  // alice crée B : elle en est la créatrice, et peut donner l'accès à bob (pas à un admin)
  const appB = (await ctx.request('POST', '/api/apps', { body: { name: 'B', type: 'static', source: 'empty' } })).data.app.id;
  assert.deepEqual(await names(), ['B']);
  let m = (await ctx.request('GET', `/api/apps/${appB}/members`)).data;
  assert.equal(m.owner.username, 'alice');
  assert.equal(m.canManage, true);
  assert.deepEqual(m.members, []);
  assert.deepEqual(m.candidates.map((c) => c.username), ['bob']); // ni elle-même, ni les administrateurs
  m = (await ctx.request('POST', `/api/apps/${appB}/members`, { body: { userId: ids.bob } })).data;
  assert.deepEqual(m.members.map((u) => u.username), ['bob']);
  assert.equal((await ctx.request('POST', `/api/apps/${appB}/members`, { body: { userId: ids.carol } })).status, 400);
  assert.equal((await ctx.request('DELETE', `/api/apps/${appB}/members/${ids.alice}`)).status, 400); // créateur figé

  // bob, membre : il voit et modifie B, mais ne gère pas la liste
  await as('bob');
  assert.deepEqual(await names(), ['B']);
  assert.equal((await ctx.request('PUT', `/api/apps/${appB}/files/content`, { body: { path: 'index.html', content: 'ok' } })).status, 200);
  m = (await ctx.request('GET', `/api/apps/${appB}/members`)).data;
  assert.equal(m.canManage, false);
  assert.deepEqual(m.candidates, []);
  assert.equal((await ctx.request('DELETE', `/api/apps/${appB}/members/${ids.bob}`)).status, 403);

  // les administrateurs voient tout, sans apparaître dans les listes ; ils gèrent les accès
  for (const who of ['admin', 'carol']) {
    await as(who);
    assert.deepEqual(await names(), ['A', 'B']);
  }
  for (const url of [`/api/apps/${appA}`, `/api/apps/${appA}/files?path=`, `/api/apps/${appA}/logs/download`]) {
    assert.equal((await ctx.request('GET', url)).status, 200, url); // les routes testées plus haut existent bien
  }
  m = (await ctx.request('GET', `/api/apps/${appA}/members`)).data;
  assert.equal(m.owner.username, 'admin'); // l'admin créateur reste affiché
  assert.deepEqual(m.candidates.map((c) => c.username), ['alice', 'bob']);
  await ctx.request('POST', `/api/apps/${appA}/members`, { body: { userId: ids.alice } });
  await as('alice');
  assert.deepEqual(await names(), ['A', 'B']);
  assert.equal((await ctx.request('GET', `/api/apps/${appA}/members`)).data.canManage, false); // membre, pas créatrice

  // un compte supprimé disparaît des listes ; le créateur supprimé reste affiché comme tel
  await as('admin');
  await ctx.request('DELETE', `/api/users/${ids.bob}`);
  await ctx.request('DELETE', `/api/users/${ids.alice}`);
  m = (await ctx.request('GET', `/api/apps/${appB}/members`)).data;
  assert.deepEqual(m.members, []);
  assert.equal(m.owner.deleted, true);
});

test('accès par application : les applis existantes sont attribuées au premier administrateur', () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'astra-store-')), 'db.json');
  writeFileSync(file, JSON.stringify({ users: [{ id: 'u1', username: 'lea', role: 'user' }, { id: 'a1', username: 'admin', role: 'admin' }], apps: [{ id: 'vieux', name: 'Vieux site' }] }));
  const store = new Store(file);
  assert.equal(store.data.apps[0].ownerId, 'a1');
  assert.deepEqual(store.data.apps[0].members, []);
});

test('gestionnaire de fichiers : copier, déplacer, compresser, extraire, aperçu', async (t) => {
  const ctx = await startTestPanel();
  t.after(() => ctx.close());
  await ctx.setupAdmin();
  const { data } = await ctx.request('POST', '/api/apps', { body: { name: 'Fichiers', type: 'static', source: 'empty' } });
  const f = `/api/apps/${data.app.id}/files`;
  await ctx.request('PUT', `${f}/content`, { body: { path: 'notes.txt', content: 'bonjour' } });
  await ctx.request('POST', `${f}/upload?path=media&name=clip.mp4`, { raw: Buffer.alloc(1000, 1) });

  let res = await ctx.request('POST', `${f}/copy`, { body: { paths: ['notes.txt'], dest: '' } });
  assert.deepEqual(res.data.names, ['notes (2).txt']);
  res = await ctx.request('POST', `${f}/move`, { body: { paths: ['notes (2).txt'], dest: 'archives' } });
  assert.deepEqual(res.data.names, ['notes (2).txt']);
  res = await ctx.request('POST', `${f}/move`, { body: { paths: ['media'], dest: 'media/sous' } });
  assert.equal(res.status, 400);

  res = await ctx.request('POST', `${f}/compress`, { body: { dir: '', names: ['archives', 'notes.txt'], archive: 'sauvegarde' } });
  assert.equal(res.data.name, 'sauvegarde.zip');
  res = await ctx.request('POST', `${f}/extract`, { body: { path: 'sauvegarde.zip' } });
  assert.equal(res.data.name, 'sauvegarde');
  res = await ctx.request('GET', `${f}?path=sauvegarde/archives`);
  assert.deepEqual(res.data.entries.map((e) => e.name), ['notes (2).txt']);

  const range = await fetch(`${ctx.base}${f}/raw?path=media/clip.mp4`, { headers: { Cookie: ctx.getCookie(), Range: 'bytes=10-19' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 10-19/1000');
  assert.match(range.headers.get('content-security-policy'), /sandbox/);

  res = await ctx.request('POST', `${f}/delete`, { body: { paths: ['sauvegarde', 'sauvegarde.zip', 'absent.txt'] } });
  assert.equal(res.status, 200);
  res = await ctx.request('GET', `${f}?path=`);
  assert.deepEqual(res.data.entries.map((e) => e.name).sort(), ['archives', 'media', 'notes.txt']);
});

test('le tunnel Cloudflare démarre avec le panel, et réessaie si cloudflared manque', async (t) => {
  const { copyFileSync, mkdirSync } = await import('node:fs');
  const { waitFor } = await import('./helpers.js');
  const ctx = await startTestPanel();
  t.after(() => ctx.close());
  const { tunnel, store } = ctx.panel;
  const token = Buffer.from(JSON.stringify({ a: 'acc', t: 'tunnel-test', s: 'c2VjcmV0' })).toString('base64');
  Object.assign(store.data.settings.tunnel, { enabled: true, mode: 'token', token });

  // cloudflared absent au démarrage : une nouvelle tentative est programmée
  await tunnel.bootstrap();
  assert.equal(tunnel.child, null);
  assert.ok(tunnel.restartTimer);

  // il apparaît : le tunnel démarre au prochain essai (2 s) et se connecte
  mkdirSync(path.dirname(tunnel.localBinary), { recursive: true });
  copyFileSync(new URL('./fixtures/fake-cloudflared.js', import.meta.url), tunnel.localBinary);
  const ready = await waitFor(async () => (await tunnel.ready())?.readyConnections > 0, { timeout: 8000 });
  assert.ok(ready);
  assert.equal((await tunnel.status()).running, true);

  // redémarrage du panel : le tunnel est relancé tout de suite
  await tunnel.stop({ persist: false });
  const begin = Date.now();
  await tunnel.bootstrap();
  await waitFor(async () => (await tunnel.ready())?.readyConnections > 0, { timeout: 5000 });
  assert.ok(Date.now() - begin < 3000, 'le tunnel doit être connecté en moins de 3 s');
});

test('démarrage avec le Raspberry Pi : option par application', async (t) => {
  const ctx = await startTestPanel();
  t.after(() => ctx.close());
  await ctx.setupAdmin();
  const cmd = 'node -e "setInterval(() => {}, 1000)"';
  const mk = async (name, startOnBoot) =>
    (await ctx.request('POST', '/api/apps', { body: { name, type: 'bot', source: 'empty', startCommand: cmd, startOnBoot } })).data.app;
  const auto = await mk('Bot auto', true);
  const manuel = await mk('Bot manuel', false);
  assert.equal(auto.startOnBoot, true);
  assert.equal(manuel.startOnBoot, false);
  const { apps } = ctx.panel;
  // avant le redémarrage : « Bot manuel » tournait, « Bot auto » était arrêté
  apps.get(manuel.id).desired = 'running';
  apps.get(auto.id).desired = 'stopped';

  // démarrage du Raspberry Pi : seule l'app avec l'option est lancée
  await apps.bootstrap({ systemBoot: true });
  assert.equal(apps.rt(auto.id).status, 'running');
  assert.equal(apps.rt(manuel.id).status, 'stopped');
  assert.equal(apps.get(manuel.id).desired, 'stopped');

  // simple redémarrage du panel : chaque app retrouve son état précédent
  await apps.stop(auto.id);
  apps.get(auto.id).desired = 'stopped';
  apps.get(manuel.id).desired = 'running';
  await apps.bootstrap({ systemBoot: false });
  assert.equal(apps.rt(auto.id).status, 'stopped');
  assert.equal(apps.rt(manuel.id).status, 'running');
});

test('rendu des tutoriels (Markdown) dans la page Aide', async () => {
  const { readFileSync } = await import('node:fs');
  const { renderMarkdown, slugify } = await import('../public/js/markdown.js');
  const ctx = {
    image: (src) => `/docs/${src}`,
    link: (label, href) => `<a href="${href}">${label}</a>`,
  };
  // identifiants des titres identiques à ceux de GitHub (liens du sommaire)
  assert.equal(slugify("1. Ce qu'il vous faut"), '1-ce-quil-vous-faut');
  assert.equal(slugify('5. Mode A : tunnel géré depuis le panel (recommandé)'), '5-mode-a--tunnel-géré-depuis-le-panel-recommandé');

  const out = renderMarkdown(
    [
      '## Titre **gras**',
      '',
      '1. Étape un',
      '   suite de la ligne',
      '',
      '   ```',
      '   sudo cloudflared service install <jeton>',
      '   ```',
      '',
      '2. Étape deux avec `code` et [lien](https://exemple.fr)',
      '   - sous-point',
      '',
      '| A | B |',
      '| --- | --- |',
      '| *x* | <script>alert(1)</script> |',
      '',
      '> **Note** : attention',
    ].join('\n'),
    ctx,
  );
  assert.match(out, /<h2 id="titre-gras">Titre <strong>gras<\/strong><\/h2>/);
  assert.match(out, /<ol><li><p>Étape un suite de la ligne<\/p>\n<pre class="code"><code>sudo cloudflared service install &lt;jeton&gt;<\/code><\/pre><\/li>/);
  assert.match(out, /<li><p>Étape deux avec <code>code<\/code> et <a href="https:\/\/exemple.fr">lien<\/a><\/p>\n<ul><li>sous-point<\/li><\/ul><\/li><\/ol>/);
  assert.match(out, /<td><em>x<\/em><\/td><td>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/td>/);
  assert.match(out, /<blockquote><p><strong>Note<\/strong> : attention<\/p><\/blockquote>/);
  assert.doesNotMatch(out, /<script>/);

  // les vrais tutoriels : chaque lien du sommaire pointe vers un titre existant
  for (const file of ['CLOUDFLARE.md', 'TUTORIEL.md']) {
    const md = readFileSync(new URL(`../docs/${file}`, import.meta.url), 'utf8');
    const html = renderMarkdown(md, { ...ctx, link: (label, href) => `<a href="${href}">${label}</a>` });
    const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
    for (const [, anchor] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(anchor), `${file} : ancre #${anchor} introuvable`);
  }
});

test('tunnel géré depuis le panel : compte retrouvé via les domaines, création du tunnel et DNS', async (t) => {
  const http = await import('node:http');
  const { copyFileSync, mkdirSync } = await import('node:fs');
  const ACC = 'a'.repeat(32);
  const records = [];
  const calls = [];
  // Fausse API Cloudflare : comme pour un vrai jeton sans « Account Settings », /accounts renvoie une liste vide.
  const cf = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d)).on('end', () => {
      const url = new URL(req.url, 'http://x');
      calls.push(`${req.method} ${url.pathname}`);
      const send = (result, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status === 200 ? { success: true, errors: [], result } : { success: false, errors: [{ message: result }] }));
      };
      if (req.headers.authorization !== 'Bearer jeton-valide-0123456789abcdef') return send('Invalid API Token', 401);
      const p = url.pathname;
      if (p === '/accounts') return send([]);
      if (p === '/zones') return send([{ id: 'z1', name: 'monsite.fr', status: 'active', account: { id: ACC, name: "moi@exemple.fr's Account" } }]);
      if (p === `/accounts/${ACC}/cfd_tunnel`) return req.method === 'GET' ? send([]) : send({ id: 'tunnel-1', name: JSON.parse(body).name });
      if (p === `/accounts/${ACC}/cfd_tunnel/tunnel-1/token`) return send(Buffer.from(JSON.stringify({ a: ACC, t: 'tunnel-1', s: 'c2VjcmV0' })).toString('base64'));
      if (p === `/accounts/${ACC}/cfd_tunnel/tunnel-1/configurations`) return send({});
      if (p === '/zones/z1/dns_records' && req.method === 'POST') {
        const r = { id: `r${records.length + 1}`, ...JSON.parse(body) };
        records.push(r);
        return send(r);
      }
      if (p === '/zones/z1/dns_records') return send(records.filter((r) => !url.searchParams.get('name') || r.name === url.searchParams.get('name')));
      return send(`route inconnue ${p}`, 404);
    });
  });
  await new Promise((r) => cf.listen(0, '127.0.0.1', r));
  process.env.ASTRA_CLOUDFLARE_API = `http://127.0.0.1:${cf.address().port}`;
  const ctx = await startTestPanel();
  t.after(async () => {
    delete process.env.ASTRA_CLOUDFLARE_API;
    await ctx.close();
    cf.close();
  });
  await ctx.setupAdmin();
  const { tunnel } = ctx.panel;
  mkdirSync(path.dirname(tunnel.localBinary), { recursive: true });
  copyFileSync(new URL('./fixtures/fake-cloudflared.js', import.meta.url), tunnel.localBinary);

  let res = await ctx.request('POST', '/api/tunnel/api/connect', { body: { apiToken: 'mauvais-jeton-0123456789abcdef' } });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /Invalid API Token/);

  res = await ctx.request('POST', '/api/tunnel/api/connect', { body: { apiToken: 'jeton-valide-0123456789abcdef' } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.deepEqual(res.data.accounts, [{ id: ACC, name: "moi@exemple.fr's Account" }]);

  res = await ctx.request('POST', '/api/tunnel/api/setup', { body: { accountId: ACC, name: 'astrapanel-test' } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.status.api.tunnelId, 'tunnel-1');
  assert.equal(res.data.status.running, true);

  const { data } = await ctx.request('POST', '/api/apps', { body: { name: 'Site', type: 'static', source: 'empty', domains: 'monsite.fr' } });
  assert.equal(data.tunnel.ok, true, JSON.stringify(data.tunnel));
  assert.deepEqual(records.map((r) => [r.type, r.name, r.content, r.proxied]), [['CNAME', 'monsite.fr', 'tunnel-1.cfargotunnel.com', true]]);
  assert.ok(calls.includes(`PUT /accounts/${ACC}/cfd_tunnel/tunnel-1/configurations`));
});

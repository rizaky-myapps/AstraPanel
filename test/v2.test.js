import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { startTestPanel } from './helpers.js';
import { Metrics } from '../src/metrics.js';
import { parseTunnelToken, hostnameOf } from '../src/tunnel.js';
import { parseGithub, parseVersionBranch, pickLatestBranch } from '../src/update.js';
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

test('branches de version : la mise à jour suit la branche « -latest »', () => {
  const names = ['main', 'claude/test', 'AstraPanel-version.1.0.0', 'AstraPanel-version.1.1.0-latest', 'AstraPanel-version.1.0.5'];
  assert.equal(pickLatestBranch(names), 'AstraPanel-version.1.1.0-latest');
  // après publication de 1.2.0, 1.1.0 a perdu son suffixe
  assert.equal(pickLatestBranch(['AstraPanel-version.1.1.0', 'AstraPanel-version.1.2.0-latest']), 'AstraPanel-version.1.2.0-latest');
  // tri numérique, pas alphabétique
  assert.equal(pickLatestBranch(['AstraPanel-version.1.9.0', 'AstraPanel-version.1.10.0']), 'AstraPanel-version.1.10.0');
  assert.equal(pickLatestBranch(['main']), null);
  assert.deepEqual(parseVersionBranch('AstraPanel-version.2.0.1-latest'), { version: '2.0.1', parts: [2, 0, 1], latest: true });
  assert.equal(parseVersionBranch('AstraPanel-version.2.0'), null);
});

test('analyse des URL GitHub', () => {
  assert.deepEqual(parseGithub('https://github.com/moi/AstraPanel.git'), { owner: 'moi', repo: 'AstraPanel', token: null });
  assert.deepEqual(parseGithub('https://ghp_x@github.com/moi/AstraPanel'), { owner: 'moi', repo: 'AstraPanel', token: 'ghp_x' });
  assert.deepEqual(parseGithub('git@github.com:moi/bot.git'), { owner: 'moi', repo: 'bot', token: null });
  assert.equal(parseGithub('https://gitlab.com/moi/bot.git'), null);
});

test('grades : un UTILISATEUR gère les applis mais pas le panel', async (t) => {
  const ctx = await startTestPanel();
  t.after(() => ctx.close());
  await ctx.setupAdmin();
  const adminCookie = ctx.getCookie();
  let res = await ctx.request('POST', '/api/users', { body: { username: 'alice', password: 'motdepasse123', role: 'user' } });
  assert.equal(res.data.role, 'user');
  const { data: app } = await ctx.request('POST', '/api/apps', { body: { name: 'Site', type: 'static', source: 'empty' } });

  ctx.setCookie('');
  res = await ctx.request('POST', '/api/auth/login', { body: { username: 'alice', password: 'motdepasse123' } });
  assert.equal(res.data.user.role, 'user');
  for (const url of ['/api/settings', '/api/users', '/api/storage', '/api/update', '/api/tunnel']) {
    assert.equal((await ctx.request('GET', url)).status, 403, url);
  }
  assert.equal((await ctx.request('GET', '/api/apps')).status, 200);
  assert.equal((await ctx.request('GET', '/api/system/metrics?range=24h')).status, 200);
  assert.equal((await ctx.request('DELETE', `/api/apps/${app.app.id}`)).status, 403);
  assert.equal((await ctx.request('PUT', `/api/apps/${app.app.id}/files/content`, { body: { path: 'a.txt', content: 'x' } })).status, 200);

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

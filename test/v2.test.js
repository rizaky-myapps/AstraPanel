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

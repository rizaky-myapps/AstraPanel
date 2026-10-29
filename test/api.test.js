import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { startTestPanel, waitFor } from './helpers.js';

test('parcours complet : installation, connexion, site statique, fichiers, webhook', async (t) => {
  const ctx = await startTestPanel();
  t.after(() => ctx.close());
  const { request, cfg } = ctx;

  // --- Première connexion -------------------------------------------------
  let res = await request('GET', '/api/auth/status');
  assert.deepEqual(res.data, { setupRequired: true, user: null });
  res = await request('GET', '/api/apps');
  assert.equal(res.status, 401);

  const token = readFileSync(path.join(cfg.dataDir, 'setup-token'), 'utf8').trim();
  res = await request('POST', '/api/auth/setup', { body: { token: 'mauvais', username: 'admin', password: 'motdepasse123' } });
  assert.equal(res.status, 403);
  res = await request('POST', '/api/auth/setup', { body: { token, username: 'admin', password: 'motdepasse123' } });
  assert.equal(res.status, 200);
  assert.equal(res.data.user.username, 'admin');
  res = await request('POST', '/api/auth/setup', { body: { token, username: 'pirate', password: 'motdepasse123' } });
  assert.equal(res.status, 409);

  // Protection CSRF : sans l'en-tête X-Astra, les requêtes qui modifient sont refusées
  const csrf = await fetch(`${ctx.base}/api/apps`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(csrf.status, 403);

  // --- Création d'un site statique depuis le modèle ------------------------
  res = await request('POST', '/api/apps', { body: { name: 'Site vitrine', type: 'static', source: 'template', start: true } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const app = res.data.app;
  assert.match(app.id, /^site-vitrine-[0-9a-f]{4}$/);
  assert.ok(app.port >= 4000);

  await waitFor(async () => (await request('GET', `/api/apps/${app.id}`)).data.runtime.status === 'running');
  const page = await waitFor(async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${app.port}/`);
      return r.ok ? r.text() : null;
    } catch {
      return null;
    }
  });
  assert.match(page, /Mon site statique/);
  assert.equal((await fetch(`http://127.0.0.1:${app.port}/.env`)).status, 404);

  // --- Gestionnaire de fichiers --------------------------------------------
  res = await request('PUT', `/api/apps/${app.id}/files/content`, { body: { path: 'contact.html', content: '<p>Contact</p>' } });
  assert.equal(res.status, 200);
  assert.equal(await (await fetch(`http://127.0.0.1:${app.port}/contact.html`)).text(), '<p>Contact</p>');
  res = await request('GET', `/api/apps/${app.id}/files?path=`);
  assert.ok(res.data.entries.some((e) => e.name === 'contact.html'));
  res = await request('GET', `/api/apps/${app.id}/files/content?path=../../db.json`);
  assert.equal(res.status, 400);
  res = await request('POST', `/api/apps/${app.id}/files/upload?path=img&name=logo.svg`, { raw: '<svg/>' });
  assert.equal(res.status, 200);
  assert.equal(await (await fetch(`http://127.0.0.1:${app.port}/img/logo.svg`)).text(), '<svg/>');

  // --- Variables, arrêt, journaux -------------------------------------------
  res = await request('PATCH', `/api/apps/${app.id}`, { body: { env: { 'MAUVAIS NOM': 'x' } } });
  assert.equal(res.status, 400);
  res = await request('PATCH', `/api/apps/${app.id}`, { body: { env: { MESSAGE: 'bonjour' } } });
  assert.deepEqual(res.data.app.env, { MESSAGE: 'bonjour' });

  res = await request('POST', `/api/apps/${app.id}/stop`);
  assert.equal(res.data.runtime.status, 'stopped');
  assert.equal(res.data.desired, 'stopped');
  const logs = ctx.panel.apps.logsFor(app.id).lines.map((l) => l.m).join('\n');
  assert.match(logs, /Démarrage/);
  assert.match(logs, /Arrêté/);

  // --- Webhook ---------------------------------------------------------------
  res = await request('POST', `/hooks/deploy/${app.id}/mauvais-jeton`, { raw: '{}' });
  assert.equal(res.status, 404);
  res = await request('POST', `/hooks/deploy/${app.id}/${app.webhookToken}`, { raw: '{}', headers: { 'X-GitHub-Event': 'ping' } });
  assert.equal(res.data.message, 'pong');

  // --- Suppression -------------------------------------------------------------
  res = await request('DELETE', `/api/apps/${app.id}`);
  assert.equal(res.status, 200);
  assert.equal((await request('GET', '/api/apps')).data.length, 0);
});

test('redémarrage automatique après un plantage', async (t) => {
  const ctx = await startTestPanel();
  t.after(() => ctx.close());
  const { request, cfg } = ctx;
  const token = readFileSync(path.join(cfg.dataDir, 'setup-token'), 'utf8').trim();
  await request('POST', '/api/auth/setup', { body: { token, username: 'admin', password: 'motdepasse123' } });

  const { data } = await request('POST', '/api/apps', {
    body: { name: 'Bot fragile', type: 'bot', source: 'empty', startCommand: 'node -e "setTimeout(() => process.exit(2), 100)"' },
  });
  const id = data.app.id;
  await request('POST', `/api/apps/${id}/start`);
  const rt = await waitFor(async () => {
    const r = (await request('GET', `/api/apps/${id}`)).data.runtime;
    return r.restarts >= 2 ? r : null;
  });
  assert.equal(rt.lastExit.code, 2);
  const stopped = await request('POST', `/api/apps/${id}/stop`);
  assert.equal(stopped.data.runtime.status, 'stopped');
});

test('connexion : mauvais mot de passe puis limitation des tentatives', async (t) => {
  const ctx = await startTestPanel();
  t.after(() => ctx.close());
  const { request, cfg } = ctx;
  const token = readFileSync(path.join(cfg.dataDir, 'setup-token'), 'utf8').trim();
  await request('POST', '/api/auth/setup', { body: { token, username: 'admin', password: 'motdepasse123' } });
  ctx.setCookie('');

  let res = await request('POST', '/api/auth/login', { body: { username: 'admin', password: 'faux' } });
  assert.equal(res.status, 401);
  res = await request('POST', '/api/auth/login', { body: { username: 'admin', password: 'motdepasse123' } });
  assert.equal(res.status, 200);
  for (let i = 0; i < 10; i++) await request('POST', '/api/auth/login', { body: { username: 'admin', password: 'faux' } });
  res = await request('POST', '/api/auth/login', { body: { username: 'admin', password: 'motdepasse123' } });
  assert.equal(res.status, 429);
});

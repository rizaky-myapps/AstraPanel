import os from 'node:os';
import path from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { config } from '../src/config.js';
import { createPanel } from '../src/server.js';

// Démarre un panel isolé (dossier de données temporaire, port aléatoire).
export async function startTestPanel({ dataDir = mkdtempSync(path.join(os.tmpdir(), 'astrapanel-test-')) } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const cfg = {
    ...config,
    dataDir,
    appsDir: path.join(dataDir, 'apps'),
    logsDir: path.join(dataDir, 'logs'),
    tmpDir: path.join(dataDir, 'tmp'),
    dbFile: path.join(dataDir, 'db.json'),
    port: 0,
  };
  const panel = createPanel(cfg);
  await new Promise((resolve) => panel.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${panel.server.address().port}`;
  let cookie = '';

  async function request(method, url, { body, headers = {}, raw } = {}) {
    const init = { method, headers: { 'X-Astra': '1', ...headers } };
    if (cookie) init.headers.Cookie = cookie;
    if (raw !== undefined) init.body = raw;
    else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(base + url, init);
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {
      // réponse non JSON
    }
    return { status: res.status, data, headers: res.headers };
  }

  async function close() {
    await Promise.all([panel.apps.shutdown(), panel.tunnel.shutdown()]);
    await new Promise((resolve) => panel.server.close(resolve));
  }

  // Connexion en tant qu'admin (création du premier compte)
  async function setupAdmin() {
    const token = readFileSync(path.join(dataDir, 'setup-token'), 'utf8').trim();
    return request('POST', '/api/auth/setup', { body: { token, username: 'admin', password: 'motdepasse123' } });
  }

  return { panel, cfg, base, request, close, setupAdmin, getCookie: () => cookie, setCookie: (c) => (cookie = c) };
}

export async function waitFor(fn, { timeout = 15000, interval = 100 } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('Délai dépassé');
    await new Promise((r) => setTimeout(r, interval));
  }
}

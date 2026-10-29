import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { Router } from '../src/http/router.js';
import { normalizeDomains, Caddy } from '../src/caddy.js';
import { LogBuffer, lineSplitter, stripAnsi } from '../src/apps/logs.js';
import { resolveInside } from '../src/apps/files.js';
import { maskUrl } from '../src/apps/manager.js';
import { hashPassword, verifyPassword } from '../src/auth.js';
import { parseDotenv, toDotenv } from '../public/js/env-editor.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'astrapanel-unit-'));

test('le routeur extrait les paramètres et distingue 404 / 405', () => {
  const router = new Router();
  router.get('/api/apps/:id/files', () => 'list');
  router.post('/api/apps/:id/tasks/cancel', () => 'cancel');
  router.post('/api/apps/:id/tasks/:task', () => 'task');
  const m = router.match('GET', '/api/apps/mon-bot-12ab/files');
  assert.equal(m.params.id, 'mon-bot-12ab');
  assert.equal(router.match('POST', '/api/apps/x/tasks/cancel').route.handler(), 'cancel');
  assert.equal(router.match('POST', '/api/apps/x/tasks/deploy').params.task, 'deploy');
  assert.equal(router.match('HEAD', '/api/apps/x/files').route.handler(), 'list');
  assert.equal(router.match('GET', '/api/inconnu'), null);
  assert.throws(() => router.match('DELETE', '/api/apps/x/files'), { status: 405 });
});

test('les domaines sont validés strictement (pas d’injection dans le Caddyfile)', () => {
  assert.deepEqual(normalizeDomains('MonSite.fr, www.monsite.fr monsite.fr'), ['monsite.fr', 'www.monsite.fr']);
  assert.deepEqual(normalizeDomains(['http://bot.local:8081/']), ['http://bot.local:8081']);
  assert.deepEqual(normalizeDomains(''), []);
  for (const bad of ['evil.com {', 'a.com\nimport /etc', 'exa_mple.com', '-site.fr', 'site.fr/chemin']) {
    assert.throws(() => normalizeDomains([bad]), { status: 400 }, bad);
  }
});

test('la configuration Caddy générée contient le panel et les sites', () => {
  const store = {
    data: {
      settings: { panelDomain: 'panel.exemple.fr', caddy: { enabled: true } },
      apps: [
        { id: 'site-1', name: 'Site', port: 4000, domains: ['exemple.fr', 'www.exemple.fr'] },
        { id: 'bot-1', name: 'Bot', port: null, domains: [] },
      ],
    },
  };
  const out = new Caddy({ store, dir: '/nope', mainConfig: '/nope', panelPort: 8080 }).generate();
  assert.match(out, /panel\.exemple\.fr \{\n\tencode zstd gzip\n\treverse_proxy 127\.0\.0\.1:8080\n\}/);
  assert.match(out, /exemple\.fr, www\.exemple\.fr \{[^}]*reverse_proxy 127\.0\.0\.1:4000/);
  assert.doesNotMatch(out, /bot-1/);
});

test('découpage des lignes et suppression des codes couleur', () => {
  const lines = [];
  const split = lineSplitter((l) => lines.push(l));
  split.write('bon');
  split.write('jour\nsal');
  split.write('ut\n');
  split.write('fin');
  split.end();
  assert.deepEqual(lines, ['bonjour', 'salut', 'fin']);
  assert.equal(stripAnsi('\x1b[32mOK\x1b[0m'), 'OK');
});

test('le journal est relu depuis le disque au redémarrage', async () => {
  const file = path.join(tmp(), 'app.log');
  const log = new LogBuffer(file, { maxLines: 3 });
  log.push('out', 'ligne 1');
  log.push('err', 'ligne 2');
  log.system('ligne 3');
  log.push('out', 'ligne 4');
  assert.deepEqual(log.lines.map((l) => l.m), ['ligne 2', 'ligne 3', 'ligne 4']);
  await new Promise((r) => log.stream.end(r));
  const reloaded = new LogBuffer(file, { maxLines: 10 });
  assert.deepEqual(reloaded.lines.map((l) => [l.s, l.m]), [['out', 'ligne 1'], ['err', 'ligne 2'], ['sys', 'ligne 3'], ['out', 'ligne 4']]);
  reloaded.close();
});

test('impossible de sortir du dossier d’une application', async () => {
  const root = tmp();
  const app = path.join(root, 'app');
  mkdirSync(path.join(app, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'secret.txt'), 'secret');
  symlinkSync(root, path.join(app, 'lien'));
  assert.equal((await resolveInside(app, 'src/../src/index.js')).rel, 'src/index.js');
  assert.equal((await resolveInside(app, '/etc/passwd')).rel, 'etc/passwd');
  await assert.rejects(resolveInside(app, '../secret.txt'), { status: 400 });
  await assert.rejects(resolveInside(app, 'lien/secret.txt'), { status: 400 });
  await assert.rejects(resolveInside(app, 'absent.txt', { mustExist: true }), { status: 404 });
});

test('hachage des mots de passe (scrypt)', async () => {
  const hash = await hashPassword('motdepasse123');
  assert.ok(hash.startsWith('scrypt$'));
  assert.equal(await verifyPassword('motdepasse123', hash), true);
  assert.equal(await verifyPassword('mauvais', hash), false);
});

test('les jetons sont masqués dans les URL Git', () => {
  assert.equal(maskUrl('https://ghp_abc123@github.com/moi/bot.git'), 'https://***@github.com/moi/bot.git');
  assert.equal(maskUrl('https://github.com/moi/bot.git'), 'https://github.com/moi/bot.git');
});

test('lecture et écriture du format .env', () => {
  const env = parseDotenv('# commentaire\nDISCORD_TOKEN=abc.def\nexport MODE="prod"\nMSG=\'a b\'\n\n');
  assert.deepEqual(env, { DISCORD_TOKEN: 'abc.def', MODE: 'prod', MSG: 'a b' });
  assert.deepEqual(parseDotenv(toDotenv({ A: 'x y', B: 'z', C: 'avec"guillemet' })), { A: 'x y', B: 'z', C: 'avec"guillemet' });
  assert.throws(() => parseDotenv('PAS UNE LIGNE'));
});

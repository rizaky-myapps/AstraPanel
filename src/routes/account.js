import path from 'node:path';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { HttpError, readBody } from '../http/util.js';
import { publicUser } from '../auth.js';

// Photo de profil : petite image (le navigateur la recadre en carré de 256 px avant l'envoi).
const AVATAR_MAX = 512 * 1024;

// Format d'après les premiers octets du fichier. Jamais de SVG : il pourrait contenir du script.
export function imageType(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export const avatarPath = (dataDir, userId) => path.join(dataDir, 'avatars', userId);

export const THEMES = ['auto', 'light', 'dark'];
export const ACCENTS = ['solaire', 'ocean', 'aurore', 'nebuleuse', 'framboise'];

// Gestion de son propre compte, pour tous les comptes : pseudo, photo, sessions, activité.
export function accountRoutes(router, { auth, store, apps, audit, config }) {
  router.get('/api/account', (ctx) => {
    const me = ctx.user;
    const visible = apps.list(me);
    return {
      user: publicUser(me),
      apps: {
        owned: visible.filter((a) => a.ownerId === me.id).length,
        shared: visible.filter((a) => a.ownerId !== me.id).length,
      },
    };
  });

  // Changement de pseudo (nom de connexion) : confirmé par le mot de passe
  router.patch('/api/account', async (ctx) => {
    const { username, password } = await ctx.json();
    const previous = ctx.user.username;
    await auth.renameUser(ctx.user, String(username || '').trim(), { password });
    return { user: publicUser(ctx.user), previous };
  });

  // Apparence du panel pour ce compte (suit le compte d'un appareil à l'autre)
  router.patch('/api/account/preferences', async (ctx) => {
    const body = await ctx.json();
    const prefs = { ...(ctx.user.prefs || {}) };
    if ('theme' in body) {
      if (!THEMES.includes(body.theme)) throw new HttpError(400, 'Thème inconnu');
      prefs.theme = body.theme;
    }
    if ('accent' in body) {
      if (!ACCENTS.includes(body.accent)) throw new HttpError(400, 'Couleur inconnue');
      prefs.accent = body.accent;
    }
    ctx.user.prefs = prefs;
    store.save();
    return { user: publicUser(ctx.user) };
  });

  router.put('/api/account/avatar', async (ctx) => {
    const buf = await readBody(ctx.req, AVATAR_MAX);
    const type = imageType(buf);
    if (!type) throw new HttpError(400, 'Image non reconnue : choisissez une photo PNG, JPEG ou WebP');
    const file = avatarPath(config.dataDir, ctx.user.id);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, buf);
    await rename(`${file}.tmp`, file);
    ctx.user.avatar = { type, v: Date.now() };
    store.save();
    return { user: publicUser(ctx.user) };
  });

  router.delete('/api/account/avatar', async (ctx) => {
    await rm(avatarPath(config.dataDir, ctx.user.id), { force: true });
    delete ctx.user.avatar;
    store.save();
    return { user: publicUser(ctx.user) };
  });

  // Photo d'un compte (visible par les comptes connectés : listes de membres, utilisateurs…)
  router.get('/api/users/:id/avatar', async (ctx) => {
    const user = store.data.users.find((u) => u.id === ctx.params.id);
    if (!user?.avatar) throw new HttpError(404, 'Pas de photo de profil');
    const data = await readFile(avatarPath(config.dataDir, user.id));
    ctx.res.writeHead(200, {
      'Content-Type': user.avatar.type,
      'Content-Length': data.length,
      // l'adresse change à chaque nouvelle photo (?v=…)
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    ctx.res.end(data);
  });

  // Déconnecte toutes les autres sessions (autres navigateurs, autres appareils) ; celle-ci reste ouverte
  router.post('/api/account/logout-others', (ctx) => {
    ctx.user.tokenVersion += 1;
    store.save();
    auth.setSessionCookie(ctx.req, ctx.res, ctx.user);
    return { ok: true };
  });

  // Activité récente du compte, et tentatives de connexion échouées avec son pseudo
  router.get('/api/account/activity', (ctx) => {
    const me = ctx.user;
    const name = `nom saisi : ${me.username}`.toLowerCase();
    const entries = [];
    for (let i = audit.entries.length - 1; i >= 0 && entries.length < 20; i--) {
      const e = audit.entries[i];
      const mine = e.user?.id === me.id;
      const failed = !e.user && e.label === 'Échec de connexion' && String(e.detail || '').toLowerCase() === name;
      if (mine || failed) entries.push({ at: e.at, label: e.label, detail: failed ? null : e.detail, app: e.app, ip: e.ip, category: e.category, failed });
    }
    return { entries };
  });
}

import { HttpError } from '../http/util.js';
import { publicUser } from '../auth.js';

export function authRoutes(router, { auth, store }) {
  router.get(
    '/api/auth/status',
    (ctx) => ({ setupRequired: auth.setupRequired, user: publicUser(auth.userFromRequest(ctx.req)) }),
    { auth: false },
  );

  router.post(
    '/api/auth/setup',
    async (ctx) => {
      if (!auth.setupRequired) throw new HttpError(409, 'Le panel est déjà configuré');
      auth.checkRateLimit(ctx.ip);
      const { token, username, password } = await ctx.json();
      if (!auth.checkSetupToken(token)) throw new HttpError(403, 'Jeton d’installation invalide');
      const user = await auth.createUser(String(username || '').trim(), password);
      auth.resetRateLimit(ctx.ip);
      auth.setSessionCookie(ctx.req, ctx.res, user);
      return { user: publicUser(user) };
    },
    { auth: false },
  );

  router.post(
    '/api/auth/login',
    async (ctx) => {
      auth.checkRateLimit(ctx.ip);
      const { username, password } = await ctx.json();
      const user = await auth.login(String(username || '').trim(), password);
      if (!user) throw new HttpError(401, 'Identifiants incorrects');
      auth.resetRateLimit(ctx.ip);
      auth.setSessionCookie(ctx.req, ctx.res, user);
      return { user: publicUser(user) };
    },
    { auth: false },
  );

  router.post(
    '/api/auth/logout',
    (ctx) => {
      auth.clearSessionCookie(ctx.res);
      return { ok: true };
    },
    { auth: false },
  );

  router.post('/api/auth/password', async (ctx) => {
    const { current, next } = await ctx.json();
    await auth.changePassword(ctx.user, current, next);
    auth.setSessionCookie(ctx.req, ctx.res, ctx.user);
    return { ok: true };
  });

  router.get('/api/users', () => store.data.users.map(publicUser));

  router.post('/api/users', async (ctx) => {
    const { username, password } = await ctx.json();
    return publicUser(await auth.createUser(String(username || '').trim(), password));
  });

  router.delete('/api/users/:id', (ctx) => {
    if (ctx.params.id === ctx.user.id) throw new HttpError(400, 'Vous ne pouvez pas supprimer votre propre compte');
    const { users } = store.data;
    const index = users.findIndex((u) => u.id === ctx.params.id);
    if (index < 0) throw new HttpError(404, 'Utilisateur introuvable');
    users.splice(index, 1);
    store.save();
    return { ok: true };
  });
}

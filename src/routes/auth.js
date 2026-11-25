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
      const user = await auth.createUser(String(username || '').trim(), password, 'admin');
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

  // --- Gestion des comptes (ADMIN) ----------------------------------------
  const findUser = (id) => {
    const user = store.data.users.find((u) => u.id === id);
    if (!user) throw new HttpError(404, 'Utilisateur introuvable');
    return user;
  };

  router.get('/api/users', () => store.data.users.map(publicUser), { admin: true });

  router.post(
    '/api/users',
    async (ctx) => {
      const { username, password, role } = await ctx.json();
      return publicUser(await auth.createUser(String(username || '').trim(), password, role || 'user'));
    },
    { admin: true },
  );

  router.patch(
    '/api/users/:id',
    async (ctx) => {
      const user = findUser(ctx.params.id);
      const { role, password } = await ctx.json();
      await auth.updateUser(user, { role, password });
      // l'admin qui change son propre mot de passe reste connecté
      if (user.id === ctx.user.id) auth.setSessionCookie(ctx.req, ctx.res, user);
      return publicUser(user);
    },
    { admin: true },
  );

  router.delete(
    '/api/users/:id',
    (ctx) => {
      if (ctx.params.id === ctx.user.id) throw new HttpError(400, 'Vous ne pouvez pas supprimer votre propre compte');
      const user = findUser(ctx.params.id);
      if (user.role === 'admin' && auth.adminCount() <= 1) throw new HttpError(400, 'Il doit rester au moins un administrateur');
      store.data.users.splice(store.data.users.indexOf(user), 1);
      store.save();
      return { ok: true };
    },
    { admin: true },
  );
}

// Gestion des ports de la box internet (onglet Paramètres → Gestion de PORT), réservée aux administrateurs.
export function portRoutes(router, { ports, apps }) {
  const admin = { admin: true };
  // serveurs de jeux (leurs ports sont ouverts automatiquement) et état complet
  const full = () => ({
    ...ports.status(),
    games: apps.apps.filter((a) => a.type === 'minecraft').map((a) => ({ id: a.id, name: a.name, port: a.port })),
  });

  router.get(
    '/api/ports',
    async () => {
      if (!ports.state) await ports.sync().catch(() => {});
      return full();
    },
    admin,
  );
  router.post('/api/ports/detect', async () => ({ detected: await ports.detect(), ...full() }), admin);
  router.patch('/api/ports', async (ctx) => (await ports.update(await ctx.json()), full()), admin);
  router.post(
    '/api/ports/sync',
    async (ctx) => {
      const { replace } = await ctx.json().catch(() => ({}));
      await ports.sync({ replace: Array.isArray(replace) ? replace.map(String) : [] });
      return full();
    },
    admin,
  );
  router.post('/api/ports/rules', async (ctx) => (await ports.addRule(await ctx.json()), full()), admin);
  router.delete('/api/ports/rules/:id', async (ctx) => (await ports.removeRule(ctx.params.id), full()), admin);

  // Ports joignables depuis Internet (tous les comptes : champ « Port » des serveurs de jeux)
  router.get('/api/ports/range', () => ({ range: ports.range() }));

  // Freebox : connexion du panel (validation sur l'écran de la box), état, déconnexion
  router.get('/api/ports/freebox', () => ports.freeboxStatus(), admin);
  // « Vérifier » : nouvelle session, pour voir un droit accordé entre-temps dans Freebox OS
  router.post('/api/ports/freebox/check', () => ports.freeboxStatus({ refresh: true }), admin);
  router.post('/api/ports/freebox/authorize', () => ports.freeboxAuthorize(), admin);
  router.delete('/api/ports/freebox', async () => (await ports.freeboxForget(), full()), admin);
}

// Serveur de fichiers statiques lancé par AstraPanel pour les apps de type « Site statique ».
import http from 'node:http';
import { serveStatic } from '../src/http/static.js';

const root = process.env.STATIC_ROOT || process.cwd();
const port = Number(process.env.PORT || 8080);
const spa = process.env.STATIC_SPA === '1';

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  res.on('finish', () => console.log(`${req.method} ${pathname} ${res.statusCode}`));
  try {
    await serveStatic(req, res, root, pathname, { spa, notFoundPage: '404.html', cacheControl: 'public, max-age=300' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500).end('Erreur interne');
  }
});

server.listen(port, () => console.log(`Site statique en ligne sur le port ${port} (dossier ${root})`));

process.on('SIGTERM', () => server.close(() => process.exit(0)));

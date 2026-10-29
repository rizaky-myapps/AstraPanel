// Site Node.js d'exemple hébergé par AstraPanel (aucune dépendance).
// Le panel fournit le port à utiliser dans la variable d'environnement PORT.
import http from 'node:http';

const PORT = Number(process.env.PORT) || 3000;
let visits = 0;

const page = (count) => `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mon site</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif;
           background: #0b0e17; color: #e7eaf3; }
    main { text-align: center; padding: 24px; }
    h1 { font-size: 2.4rem; margin: 0 0 8px; }
    p { color: #8d95ad; }
    code { background: #192036; padding: 2px 6px; border-radius: 6px; }
  </style>
</head>
<body>
  <main>
    <h1>🚀 Mon site est en ligne</h1>
    <p>Servi par Node.js ${process.version} sur le port ${PORT}.</p>
    <p>Visites depuis le démarrage : <b>${count}</b></p>
    <p>Modifiez <code>server.js</code> dans l'onglet « Fichiers » du panel, puis redémarrez.</p>
  </main>
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/api/hello') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Bonjour depuis le Raspberry Pi !', time: new Date().toISOString() }));
    return;
  }
  visits += 1;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page(visits));
});

server.listen(PORT, () => console.log(`🌐 Site en ligne sur le port ${PORT}`));

process.on('SIGTERM', () => server.close(() => process.exit(0)));

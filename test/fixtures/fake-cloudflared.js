#!/usr/bin/env node
// Faux cloudflared pour les tests : répond à --version et expose /ready sur le port de métriques.
const http = require('node:http');
if (process.argv.includes('--version')) {
  console.log('cloudflared version 2026.11.2 (test)');
  process.exit(0);
}
if (!process.env.TUNNEL_TOKEN) process.exit(1);
const [host, port] = process.argv[process.argv.indexOf('--metrics') + 1].split(':');
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 200, readyConnections: 4, connectorId: 'test' }));
  })
  .listen(Number(port), host, () => console.error('INF Registered tunnel connection'));
process.on('SIGTERM', () => process.exit(0));

import { readFile, readdir, readlink } from 'node:fs/promises';

// Qui écoute sur ce port TCP ? Lecture de /proc (Linux), sans dépendance.
// Retourne null si personne n'écoute ; { pid: null } si le processus appartient à un autre compte du système
// (ses descripteurs ne sont pas lisibles) ; sinon { pid, pgid, cwd, command }.
export async function portOwner(port) {
  const inodes = new Set();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const table = await readFile(file, 'utf8').catch(() => '');
    for (const line of table.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      // colonnes : sl, adresse locale (IP:PORT en hexadécimal), adresse distante, état (0A = LISTEN), …, inode
      if (cols.length < 10 || cols[3] !== '0A') continue;
      if (parseInt(cols[1].split(':').pop(), 16) === port) inodes.add(cols[9]);
    }
  }
  if (!inodes.size) return null;

  for (const pid of await readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(pid)) continue;
    const fds = await readdir(`/proc/${pid}/fd`).catch(() => null);
    if (!fds) continue; // processus d'un autre compte
    for (const fd of fds) {
      const link = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
      const socket = /^socket:\[(\d+)\]$/.exec(link)?.[1];
      if (!socket || !inodes.has(socket)) continue;
      const [cmdline, stat, cwd] = await Promise.all([
        readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => ''),
        readFile(`/proc/${pid}/stat`, 'utf8').catch(() => ''),
        readlink(`/proc/${pid}/cwd`).catch(() => null),
      ]);
      // stat : « pid (nom) état ppid pgrp … » ; le nom peut contenir des espaces et des parenthèses
      const pgid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]) || null;
      return { pid: Number(pid), pgid, cwd, command: cmdline.split('\0').filter(Boolean).join(' ') };
    }
  }
  return { pid: null };
}

// Processus lisibles par le panel (même compte système) : pid, groupe, parent, dossier courant et commande.
export async function listProcesses() {
  const out = [];
  for (const pid of await readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(pid)) continue;
    const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => null);
    if (!cwd) continue; // processus d'un autre compte, ou déjà terminé
    const [stat, cmdline] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8').catch(() => ''),
      readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => ''),
    ]);
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z') continue; // zombie : déjà terminé
    out.push({
      pid: Number(pid),
      ppid: Number(fields[1]) || 0,
      pgid: Number(fields[2]) || 0,
      cwd: cwd.replace(/ \(deleted\)$/, ''),
      command: cmdline.split('\0').filter(Boolean).join(' '),
    });
  }
  return out;
}

// Port mentionné dans une erreur « EADDRINUSE » de Node.js (« … 0.0.0.0:8080 », « … :::8999 »).
export function addrInUsePort(text) {
  const m = /EADDRINUSE\b[^\n]*?:(\d{2,5})\b/.exec(String(text));
  return m ? Number(m[1]) : null;
}

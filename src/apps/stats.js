import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';

function getconf(name, fallback) {
  try {
    return Number(execFileSync('getconf', [name], { encoding: 'utf8' }).trim()) || fallback;
  } catch {
    return fallback;
  }
}

// Le noyau du Raspberry Pi 5 utilise des pages de 16 Ko : on ne suppose rien.
export const PAGE_SIZE = getconf('PAGESIZE', 4096);
export const CLK_TCK = getconf('CLK_TCK', 100);

/**
 * Additionne le temps CPU et la RAM de tous les processus de chaque groupe demandé
 * (une app = un groupe de processus, ce qui inclut les enfants lancés par `npm start`).
 * Retourne une Map pgid -> { ticks, rss } ou null si /proc n'existe pas (hors Linux).
 */
export async function sampleProcessGroups(pgids) {
  let entries;
  try {
    entries = await readdir('/proc');
  } catch {
    return null;
  }
  const result = new Map();
  await Promise.all(
    entries.map(async (name) => {
      if (!/^\d+$/.test(name)) return;
      let content;
      try {
        content = await readFile(`/proc/${name}/stat`, 'utf8');
      } catch {
        return;
      }
      // le nom du processus (champ 2) peut contenir des espaces : on repart de la dernière parenthèse
      const fields = content.slice(content.lastIndexOf(')') + 2).split(' ');
      const pgrp = Number(fields[2]);
      if (!pgids.has(pgrp)) return;
      const entry = result.get(pgrp) || { ticks: 0, rss: 0 };
      entry.ticks += Number(fields[11]) + Number(fields[12]);
      entry.rss += Number(fields[21]) * PAGE_SIZE;
      result.set(pgrp, entry);
    }),
  );
  return result;
}

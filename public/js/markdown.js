// Conversion Markdown -> HTML, limitée à ce qu'utilisent les tutoriels du dépôt
// (titres, paragraphes, listes imbriquées, tableaux, citations, blocs de code, liens, images).
import { esc } from './ui.js';

// Identifiant des titres, comme sur GitHub (pour que les liens du sommaire fonctionnent)
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

const LIST_RE = /^(\s*)([-*]|\d+\.)\s+/;
const indentOf = (line) => line.search(/\S/);

function inline(text, ctx) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, code) => `\u0000${codes.push(code) - 1}\u0000`);
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `<img src="${ctx.image(src)}" alt="${alt}" loading="lazy" />`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => ctx.link(label, href));
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[i])}</code>`);
  return s;
}

function startsBlock(line) {
  return /^(#{1,6}\s|\s*```|\s*>|\s*\|)/.test(line) || LIST_RE.test(line) || /^\s*---\s*$/.test(line);
}

function parseBlocks(lines, ctx) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    let m;

    // Bloc de code
    if ((m = /^(\s*)```/.exec(line))) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i].slice(Math.min(m[1].length, Math.max(0, indentOf(lines[i])))));
        i++;
      }
      i++;
      out.push(`<pre class="code"><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // Titre
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      const level = m[1].length;
      const text = m[2].trim();
      out.push(`<h${level} id="${esc(slugify(text))}">${inline(text, ctx)}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*---\s*$/.test(line)) {
      out.push('<hr />');
      i++;
      continue;
    }

    // Tableau
    if (line.trim().startsWith('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || '')) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));
      out.push(
        `<div class="doc-table"><table class="table"><thead><tr>${head.map((c) => `<th>${inline(c, ctx)}</th>`).join('')}</tr></thead>` +
          `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, ctx)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`,
      );
      continue;
    }

    // Citation (encadré)
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${parseBlocks(buf, ctx)}</blockquote>`);
      continue;
    }

    // Liste (éventuellement imbriquée, avec du code dans les éléments)
    if ((m = LIST_RE.exec(line))) {
      const base = m[1].length;
      const ordered = /\d/.test(m[2]);
      const first = ordered ? parseInt(m[2], 10) : 1;
      const items = [];
      while (i < lines.length) {
        const lm = LIST_RE.exec(lines[i]);
        if (!lm || lm[1].length !== base || /\d/.test(lm[2]) !== ordered) break;
        const contentIndent = lm[0].length;
        const buf = [lines[i].slice(contentIndent)];
        i++;
        while (i < lines.length) {
          const l = lines[i];
          if (!l.trim()) {
            let j = i + 1;
            while (j < lines.length && !lines[j].trim()) j++;
            if (j < lines.length && indentOf(lines[j]) > base) {
              buf.push('');
              i++;
              continue;
            }
            break;
          }
          if (indentOf(l) <= base) break;
          buf.push(l.slice(Math.min(indentOf(l), contentIndent)));
          i++;
        }
        items.push(buf);
      }
      const tag = ordered ? 'ol' : 'ul';
      const start = ordered && first !== 1 ? ` start="${first}"` : '';
      const body = items
        .map((buf) => {
          const inner = parseBlocks(buf, ctx);
          const single = /^<p>([\s\S]*)<\/p>$/.exec(inner);
          return `<li>${single && !single[1].includes('<p>') ? single[1] : inner}</li>`;
        })
        .join('');
      out.push(`<${tag}${start}>${body}</${tag}>`);
      continue;
    }

    // Paragraphe
    const buf = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) buf.push(lines[i++].trim());
    out.push(`<p>${inline(buf.join(' '), ctx)}</p>`);
  }
  return out.join('\n');
}

/**
 * ctx.link(label, href) et ctx.image(src) reçoivent des valeurs déjà échappées
 * et renvoient le HTML du lien / l'URL de l'image.
 */
export function renderMarkdown(markdown, ctx) {
  return parseBlocks(String(markdown).replace(/\r/g, '').split('\n'), ctx);
}

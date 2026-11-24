/**
 * Native HTML Reader & Source Renderer (SPEC-001)
 * Modo Reader: limpa <script>/<style>/<svg>, decodifica entidades HTML e extrai
 * títulos, parágrafos, links, listas, citações, blocos de código e tabelas
 * formatadas diretamente no terminal.
 * Modo Source: código-fonte HTML colorido com números de linha.
 */

import { fg, type ThemePalette } from '../themes/palette.js';
import { BOLD, DIM, ITALIC, RESET, UNDERLINE, stripUnsafeAnsi, visibleLength, wrapPlainText } from '../tui/ansi.js';
import { renderCodeLines } from './code.js';

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  bull: '•',
  rarr: '→',
  larr: '←',
};

export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (full, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const cp = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : full;
    }
    if (entity.startsWith('#')) {
      const cp = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : full;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? full;
  });
}

function cleanInlineHtml(fragment: string): string {
  let text = fragment
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const cleanLabel = label.replace(/<[^>]+>/g, '').trim();
      return cleanLabel ? `${cleanLabel} [${href}]` : `[${href}]`;
    })
    .replace(/<img\b[^>]*alt=["']([^"']+)["'][^>]*>/gi, '[IMG: $1]')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  text = decodeHtmlEntities(text);
  return stripUnsafeAnsi(text).replace(/[ \t]+/g, ' ').trim();
}

function renderHtmlTable(tableHtml: string, maxWidth: number, theme: ThemePalette): string[] {
  const rowMatches = [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  const rows: string[][] = [];

  for (const r of rowMatches) {
    const cells = [...(r[1] ?? '').matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)].map((c) =>
      cleanInlineHtml(c[1] ?? '')
    );
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return [];

  const colCount = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: colCount }, (_, col) =>
    Math.min(28, Math.max(4, ...rows.map((r) => visibleLength(r[col] ?? ''))))
  );
  const b = (s: string): string => `${fg(theme.border)}${s}${RESET}`;
  const out: string[] = [b(`┌${widths.map((w) => '─'.repeat(w + 2)).join('┬')}┐`)];

  rows.forEach((row, rIdx) => {
    const cols = widths.map((w, cIdx) => {
      const raw = row[cIdx] ?? '';
      const clipped = raw.length > w ? `${raw.slice(0, Math.max(1, w - 1))}…` : raw;
      const pad = ' '.repeat(Math.max(0, w - visibleLength(clipped)));
      const styled = rIdx === 0 ? `${fg(theme.accent)}${BOLD}${clipped}${RESET}` : `${fg(theme.text)}${clipped}${RESET}`;
      return ` ${styled}${pad} `;
    });
    out.push(`${b('│')}${cols.join(b('│'))}${b('│')}`);
    if (rIdx === 0 && rows.length > 1) {
      out.push(b(`├${widths.map((w) => '─'.repeat(w + 2)).join('┼')}┤`));
    }
  });
  out.push(b(`└${widths.map((w) => '─'.repeat(w + 2)).join('┴')}┘`));
  void maxWidth;
  return out;
}

export function renderHtmlDocument(
  content: string,
  width: number,
  theme: ThemePalette,
  mode: 'reader' | 'source' = 'reader'
): string[] {
  if (mode === 'source') {
    return renderCodeLines(content, { language: 'html', theme, showLineNumbers: true });
  }

  const safeWidth = Math.max(24, width);
  const out: string[] = [];

  // Extrai título do documento
  const titleMatch = content.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) {
    const docTitle = cleanInlineHtml(titleMatch[1]);
    if (docTitle) {
      const inner = Math.min(safeWidth - 4, Math.max(visibleLength(docTitle) + 8, 28));
      const label = `HTML · ${docTitle}`;
      const clipped = label.length > inner - 2 ? `${label.slice(0, inner - 3)}…` : label;
      const pad = ' '.repeat(Math.max(0, inner - visibleLength(clipped) - 1));
      out.push(`${fg(theme.accent)}${BOLD}╭${'─'.repeat(inner)}╮${RESET}`);
      out.push(`${fg(theme.accent)}${BOLD}│ ${clipped}${pad}│${RESET}`);
      out.push(`${fg(theme.accent)}${BOLD}╰${'─'.repeat(inner)}╯${RESET}`);
      out.push('');
    }
  }

  // Remove blocos não textuais (<script>, <style>, <noscript>, <svg>, comentários, <head>)
  const bodyMatch = content.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const stripped = (bodyMatch?.[1] ?? content)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

  // Varre blocos semânticos na ordem em que aparecem no documento
  const blockRe =
    /<(h[1-6]|p|li|blockquote|pre|table|hr)\b[^>]*>([\s\S]*?)<\/\1>|<hr\s*\/?>/gi;
  let matchCount = 0;

  for (const m of stripped.matchAll(blockRe)) {
    matchCount++;
    const tag = (m[1] ?? 'hr').toLowerCase();
    const inner = m[2] ?? '';

    if (tag === 'hr') {
      out.push(`${fg(theme.border)}${'─'.repeat(Math.max(10, safeWidth - 2))}${RESET}`);
      continue;
    }

    if (tag === 'table') {
      out.push(...renderHtmlTable(inner, safeWidth, theme), '');
      continue;
    }

    if (tag === 'pre') {
      const codeText = decodeHtmlEntities(inner.replace(/<[^>]+>/g, ''));
      out.push(`${fg(theme.border)}╭─ CODE ${'─'.repeat(Math.max(4, safeWidth - 10))}╮${RESET}`);
      for (const l of codeText.replace(/\r\n/g, '\n').split('\n')) {
        out.push(`${fg(theme.border)}│${RESET} ${fg(theme.syntaxString)}${stripUnsafeAnsi(l)}${RESET}`);
      }
      out.push(`${fg(theme.border)}╰${'─'.repeat(Math.max(4, safeWidth - 2))}╯${RESET}`, '');
      continue;
    }

    const clean = cleanInlineHtml(inner);
    if (!clean) continue;

    if (tag.startsWith('h')) {
      const level = Number(tag[1]) || 2;
      const color = level === 1 ? theme.accent : level === 2 ? theme.accentAlt : theme.dir;
      const prefix = level === 1 ? '◆ ' : level === 2 ? '▌ ' : '▸ ';
      out.push(`${fg(color)}${BOLD}${prefix}${clean}${RESET}`);
      if (level <= 2) {
        out.push(`${fg(theme.border)}${'─'.repeat(Math.min(safeWidth - 2, visibleLength(clean) + 4))}${RESET}`);
      }
      continue;
    }

    if (tag === 'li') {
      const wrapped = wrapPlainText(clean, Math.max(16, safeWidth - 4));
      wrapped.forEach((w, idx) => {
        out.push(idx === 0 ? `  ${fg(theme.accent)}•${RESET} ${fg(theme.text)}${w}${RESET}` : `    ${fg(theme.text)}${w}${RESET}`);
      });
      continue;
    }

    if (tag === 'blockquote') {
      for (const w of wrapPlainText(clean, Math.max(16, safeWidth - 4))) {
        out.push(`${fg(theme.accentAlt)}┃${RESET} ${ITALIC}${fg(theme.text)}${w}${RESET}`);
      }
      out.push('');
      continue;
    }

    // Parágrafo: destaca URLs entre colchetes [https://...]
    for (const w of wrapPlainText(clean, Math.max(16, safeWidth - 2))) {
      const styled = w.replace(
        /(\[[^\]]+\])/g,
        `${fg(theme.accent)}${UNDERLINE}$1${RESET}${fg(theme.text)}`
      );
      out.push(`${fg(theme.text)}${styled}${RESET}`);
    }
    out.push('');
  }

  // Fallback para fragmentos HTML sem tags de bloco
  if (matchCount === 0) {
    const fallback = cleanInlineHtml(stripped);
    if (fallback) {
      for (const w of wrapPlainText(fallback, Math.max(16, safeWidth - 2))) {
        out.push(`${fg(theme.text)}${w}${RESET}`);
      }
    } else {
      out.push(`${fg(theme.muted)}${ITALIC}(documento HTML sem conteúdo textual visível — pressione Tab para ver o Source)${RESET}`);
    }
  }

  out.push(`${fg(theme.muted)}${DIM}Dica: pressione Tab para alternar entre Reader e Source HTML.${RESET}`);
  return out;
}

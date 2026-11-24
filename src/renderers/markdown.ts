/**
 * Native Rich Terminal Markdown Renderer (SPEC-001)
 * Renderiza Markdown com títulos estilizados, inline formatting (bold, italic,
 * strike, inline code, links), tabelas Unicode alinhadas, listas/checklists,
 * callouts GitHub ([!NOTE]/[!TIP]/[!WARNING]), citações e blocos de código coloridos.
 */

import { bg, fg, type ThemePalette } from '../themes/palette.js';
import {
  BOLD,
  DIM,
  ITALIC,
  RESET,
  STRIKE,
  UNDERLINE,
  stripUnsafeAnsi,
  visibleLength,
  wrapAnsi,
} from '../tui/ansi.js';
import { highlightCodeLine, normalizeLangAlias, renderCodeLines } from './code.js';

function styleInlineMarkdown(text: string, theme: ThemePalette): string {
  const safe = stripUnsafeAnsi(text);
  // 1. Protege inline code `...` primeiro para não aplicar bold/italic dentro de código
  const codeSpans: string[] = [];
  let working = safe.replace(/`([^`]+)`/g, (_m, inner: string) => {
    const idx = codeSpans.length;
    codeSpans.push(`${bg(theme.codeBg)}${fg(theme.accent)} ${inner} ${RESET}`);
    return `\uE000CODE${idx}\uE001`;
  });

  // 2. Links [texto](url) e imagens ![alt](url)
  working = working.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    `${fg(theme.accentAlt)}[IMG: $1]${RESET} ${fg(theme.muted)}${DIM}($2)${RESET}`
  );
  working = working.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    `${fg(theme.accent)}${UNDERLINE}$1${RESET} ${fg(theme.muted)}${DIM}($2)${RESET}`
  );

  // 3. Bold + Italic, Bold, Strikethrough, Italic
  working = working.replace(/\*\*\*([^*]+)\*\*\*/g, `${BOLD}${ITALIC}${fg(theme.text)}$1${RESET}`);
  working = working.replace(/\*\*([^*]+)\*\*/g, `${BOLD}${fg(theme.text)}$1${RESET}`);
  working = working.replace(/__([^_]+)__/g, `${BOLD}${fg(theme.text)}$1${RESET}`);
  working = working.replace(/~~([^~]+)~~/g, `${STRIKE}${fg(theme.muted)}$1${RESET}`);
  working = working.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, `$1${ITALIC}${fg(theme.text)}$2${RESET}`);

  // 4. Restaura inline code
  working = working.replace(/\uE000CODE(\d+)\uE001/g, (_m, n: string) => codeSpans[Number(n)] ?? '');
  return `${fg(theme.text)}${working}${RESET}`;
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line);
}

function parseTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((cell) => stripUnsafeAnsi(cell.trim()));
}

function renderMarkdownTable(rows: string[][], maxWidth: number, theme: ThemePalette): string[] {
  if (rows.length === 0) return [];
  const colCount = Math.max(...rows.map((r) => r.length));
  const colWidths = Array.from({ length: colCount }, (_, col) =>
    Math.max(3, ...rows.map((r) => visibleLength(r[col] ?? '')))
  );

  // Compacta proporcionalmente se a tabela exceder a largura do painel
  const chrome = colCount * 3 + 1;
  const available = Math.max(colCount * 4, maxWidth - chrome);
  const totalWidth = colWidths.reduce((a, b) => a + b, 0);
  if (totalWidth > available) {
    const ratio = available / totalWidth;
    for (let c = 0; c < colCount; c++) {
      colWidths[c] = Math.max(4, Math.floor((colWidths[c] ?? 4) * ratio));
    }
  }

  const b = (s: string): string => `${fg(theme.border)}${s}${RESET}`;
  const top = b(`┌${colWidths.map((w) => '─'.repeat(w + 2)).join('┬')}┐`);
  const mid = b(`├${colWidths.map((w) => '─'.repeat(w + 2)).join('┼')}┤`);
  const bot = b(`└${colWidths.map((w) => '─'.repeat(w + 2)).join('┴')}┘`);

  const out: string[] = [top];
  rows.forEach((row, rowIdx) => {
    const cells = colWidths.map((w, colIdx) => {
      const raw = row[colIdx] ?? '';
      const clipped = raw.length > w ? `${raw.slice(0, Math.max(1, w - 1))}…` : raw;
      const pad = ' '.repeat(Math.max(0, w - visibleLength(clipped)));
      const styled =
        rowIdx === 0
          ? `${fg(theme.accent)}${BOLD}${clipped}${RESET}${pad}`
          : `${styleInlineMarkdown(clipped, theme)}${pad}`;
      return ` ${styled} `;
    });
    out.push(`${b('│')}${cells.join(b('│'))}${b('│')}`);
    if (rowIdx === 0 && rows.length > 1) out.push(mid);
  });
  out.push(bot);
  return out;
}

export function renderMarkdown(
  content: string,
  width: number,
  theme: ThemePalette,
  mode: 'rendered' | 'raw' = 'rendered'
): string[] {
  if (mode === 'raw') {
    return renderCodeLines(content, { language: 'md', theme, showLineNumbers: true });
  }

  const safeWidth = Math.max(24, width);
  const rawLines = content.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];

  let i = 0;
  while (i < rawLines.length) {
    const line = rawLines[i] ?? '';
    const trimmed = line.trim();

    // Linha em branco
    if (!trimmed) {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      i++;
      continue;
    }

    // Bloco de código cercado ```lang ... ```
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})\s*([a-zA-Z0-9_+-]*)/);
    if (fenceMatch) {
      const fence = fenceMatch[1] ?? '```';
      const langRaw = fenceMatch[2] ?? '';
      const lang = normalizeLangAlias(langRaw);
      const badge = langRaw ? ` ${langRaw.toUpperCase()} ` : ' CODE ';
      const barLen = Math.max(2, safeWidth - badge.length - 4);
      out.push(`${fg(theme.border)}╭─${RESET}${bg(theme.headerBg)}${fg(theme.accent)}${BOLD}${badge}${RESET}${fg(theme.border)}${'─'.repeat(barLen)}╮${RESET}`);

      i++;
      let lineNum = 1;
      while (i < rawLines.length && !(rawLines[i] ?? '').trim().startsWith(fence)) {
        const codeLine = highlightCodeLine(rawLines[i] ?? '', lang, theme);
        const num = String(lineNum).padStart(3, ' ');
        out.push(`${fg(theme.border)}│${RESET} ${fg(theme.muted)}${DIM}${num}${RESET} ${codeLine}`);
        lineNum++;
        i++;
      }
      out.push(`${fg(theme.border)}╰${'─'.repeat(Math.max(4, safeWidth - 2))}╯${RESET}`);
      i++;
      continue;
    }

    // Tabela Markdown (cabeçalho + separador)
    if (trimmed.includes('|') && i + 1 < rawLines.length && isTableSeparator(rawLines[i + 1] ?? '')) {
      const tableRows: string[][] = [parseTableRow(line)];
      i += 2;
      while (i < rawLines.length) {
        const rowLine = (rawLines[i] ?? '').trim();
        if (!rowLine || !rowLine.includes('|')) break;
        tableRows.push(parseTableRow(rowLine));
        i++;
      }
      out.push(...renderMarkdownTable(tableRows, safeWidth, theme));
      continue;
    }

    // Regra horizontal
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      out.push(`${fg(theme.border)}${'─'.repeat(Math.max(10, safeWidth - 2))}${RESET}`);
      i++;
      continue;
    }

    // Cabeçalhos H1..H6
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (headingMatch) {
      const level = (headingMatch[1] ?? '#').length;
      const title = stripUnsafeAnsi(headingMatch[2] ?? '');
      if (level === 1) {
        const innerW = Math.min(safeWidth - 4, Math.max(visibleLength(title) + 2, 24));
        const border = '═'.repeat(innerW);
        const pad = ' '.repeat(Math.max(0, innerW - visibleLength(title) - 1));
        out.push(`${fg(theme.accent)}${BOLD}╔${border}╗${RESET}`);
        out.push(`${fg(theme.accent)}${BOLD}║ ${title}${pad}║${RESET}`);
        out.push(`${fg(theme.accent)}${BOLD}╚${border}╝${RESET}`);
      } else if (level === 2) {
        out.push(`${fg(theme.accentAlt)}${BOLD}▌ ${title}${RESET}`);
        out.push(`${fg(theme.border)}${'─'.repeat(Math.min(safeWidth - 2, visibleLength(title) + 4))}${RESET}`);
      } else if (level === 3) {
        out.push(`${fg(theme.accent)}${BOLD}▸ ${title}${RESET}`);
      } else {
        out.push(`${fg(theme.dir)}${BOLD}${'·'.repeat(level - 2)} ${title}${RESET}`);
      }
      i++;
      continue;
    }

    // Blockquotes & GitHub Callouts (> [!NOTE], > [!WARNING], etc.)
    if (trimmed.startsWith('>')) {
      const body = trimmed.replace(/^>\s?/, '');
      const callout = body.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
      if (callout) {
        const kind = (callout[1] ?? 'NOTE').toUpperCase();
        const color =
          kind === 'WARNING' || kind === 'CAUTION'
            ? theme.warning
            : kind === 'TIP'
              ? theme.success
              : kind === 'IMPORTANT'
                ? theme.accentAlt
                : theme.accent;
        const icon = kind === 'TIP' ? '✦' : kind === 'WARNING' || kind === 'CAUTION' ? '▲' : '◆';
        out.push(`${fg(color)}${BOLD}┃ ${icon} ${kind}${RESET}${callout[2] ? ` ${styleInlineMarkdown(callout[2], theme)}` : ''}`);
      } else {
        for (const wrapped of wrapAnsi(styleInlineMarkdown(body, theme), Math.max(16, safeWidth - 4))) {
          out.push(`${fg(theme.accentAlt)}┃${RESET} ${ITALIC}${wrapped}${RESET}`);
        }
      }
      i++;
      continue;
    }

    // Listas com Checkboxes ou Bullets / Numeradas
    const checkMatch = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.+)$/);
    if (checkMatch) {
      const indent = ' '.repeat(Math.min(8, (checkMatch[1] ?? '').length));
      const checked = (checkMatch[2] ?? '').toLowerCase() === 'x';
      const box = checked ? `${fg(theme.success)}${BOLD}☑${RESET}` : `${fg(theme.muted)}☐${RESET}`;
      const wrapped = wrapAnsi(styleInlineMarkdown(checkMatch[3] ?? '', theme), Math.max(16, safeWidth - indent.length - 4));
      wrapped.forEach((w, idx) => {
        out.push(idx === 0 ? `${indent}${box} ${w}` : `${indent}  ${w}`);
      });
      i++;
      continue;
    }

    const bulletMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (bulletMatch) {
      const depth = Math.floor((bulletMatch[1] ?? '').length / 2);
      const indent = ' '.repeat(Math.min(8, depth * 2));
      const bullets = ['•', '◦', '▪'];
      const mark = `${fg(theme.accent)}${bullets[depth % bullets.length]}${RESET}`;
      const wrapped = wrapAnsi(styleInlineMarkdown(bulletMatch[2] ?? '', theme), Math.max(16, safeWidth - indent.length - 4));
      wrapped.forEach((w, idx) => {
        out.push(idx === 0 ? `${indent}${mark} ${w}` : `${indent}  ${w}`);
      });
      i++;
      continue;
    }

    const orderedMatch = line.match(/^(\s*)(\d+[.)])\s+(.+)$/);
    if (orderedMatch) {
      const indent = ' '.repeat(Math.min(6, (orderedMatch[1] ?? '').length));
      const num = `${fg(theme.accent)}${BOLD}${orderedMatch[2]}${RESET}`;
      const wrapped = wrapAnsi(styleInlineMarkdown(orderedMatch[3] ?? '', theme), Math.max(16, safeWidth - indent.length - 6));
      wrapped.forEach((w, idx) => {
        out.push(idx === 0 ? `${indent}${num} ${w}` : `${indent}   ${w}`);
      });
      i++;
      continue;
    }

    // Parágrafo normal com word-wrap preservando estilos inline entre linhas
    for (const wrapped of wrapAnsi(styleInlineMarkdown(trimmed, theme), Math.max(16, safeWidth - 2))) {
      out.push(wrapped);
    }
    i++;
  }

  return out.length > 0 ? out : [`${fg(theme.muted)}${ITALIC}(arquivo Markdown vazio)${RESET}`];
}

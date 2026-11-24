/**
 * ANSI Primitives & Terminal Safety (SPEC-001)
 * Sanitização anti-ANSI-injection, medição de largura visível, truncamento,
 * quebra de linha preservando estilos e destaque de busca.
 */

import { bg, fg, type RgbColor } from '../themes/palette.js';

export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';
export const ITALIC = '\x1b[3m';
export const UNDERLINE = '\x1b[4m';
export const STRIKE = '\x1b[9m';

const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;
const UNSAFE_ESCAPE_RE =
  /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|P[^\x1b]*\x1b\\|\[[0-9;?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * Remove qualquer sequência de escape ANSI/OSC/DCS e caracteres de controle C0
 * de texto lido de disco para impedir ataques de ANSI injection no terminal.
 */
export function stripUnsafeAnsi(input: string): string {
  return input
    .replace(UNSAFE_ESCAPE_RE, '')
    .replace(CONTROL_CHARS_RE, '')
    .replace(/\t/g, '  ');
}

/** Remove apenas códigos SGR de cor/estilo para cálculo de texto puro. */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_SGR_RE, '');
}

/** Estima a largura de exibição em colunas (tratando emojis/CJK como largura 2). */
export function charDisplayWidth(codePoint: number): number {
  if (codePoint === 0) return 0;
  // Combining diacritical marks & variation selectors
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    codePoint === 0x200d
  ) {
    return 0;
  }
  // Common wide ranges (CJK, fullwidth, emoji blocks)
  if (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff))
  ) {
    return 2;
  }
  return 1;
}

/** Retorna a largura visível de uma string contendo sequências ANSI SGR. */
export function visibleLength(input: string): number {
  const plain = stripAnsi(input);
  let width = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) ?? 0;
    width += charDisplayWidth(cp);
  }
  return width;
}

/**
 * Trunca uma string com estilos ANSI para no máximo `maxWidth` colunas visíveis,
 * fechando o estilo com RESET quando necessário.
 */
export function truncateAnsi(input: string, maxWidth: number, ellipsis = '…'): string {
  if (maxWidth <= 0) return '';
  if (visibleLength(input) <= maxWidth) return input;

  const ellipsisWidth = visibleLength(ellipsis);
  const target = Math.max(0, maxWidth - ellipsisWidth);
  let width = 0;
  let out = '';
  let i = 0;
  let hadAnsi = false;

  while (i < input.length) {
    if (input[i] === '\x1b' && input[i + 1] === '[') {
      const end = input.indexOf('m', i);
      if (end !== -1) {
        out += input.slice(i, end + 1);
        hadAnsi = true;
        i = end + 1;
        continue;
      }
    }
    const cp = input.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const w = charDisplayWidth(cp);
    if (width + w > target) break;
    out += ch;
    width += w;
    i += ch.length;
  }

  return `${out}${ellipsis}${hadAnsi ? RESET : ''}`;
}

/** Ajusta uma linha estilizada para ocupar exatamente `width` colunas visíveis. */
export function fitAnsi(input: string, width: number): string {
  if (width <= 0) return '';
  const truncated = truncateAnsi(input, width);
  const pad = Math.max(0, width - visibleLength(truncated));
  return `${truncated}${' '.repeat(pad)}`;
}

/** Quebra texto plano (já sanitizado) por palavras respeitando `maxWidth` colunas. */
export function wrapPlainText(text: string, maxWidth: number): string[] {
  const safeWidth = Math.max(8, maxWidth);
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];

  const lines: string[] = [];
  let current = '';
  let currentWidth = 0;

  for (const word of words) {
    const wordWidth = visibleLength(word);
    if (currentWidth === 0) {
      if (wordWidth <= safeWidth) {
        current = word;
        currentWidth = wordWidth;
      } else {
        // Hard-break long tokens (URLs, hashes)
        let chunk = '';
        let chunkW = 0;
        for (const ch of word) {
          const w = charDisplayWidth(ch.codePointAt(0) ?? 0);
          if (chunkW + w > safeWidth && chunkW > 0) {
            lines.push(chunk);
            chunk = ch;
            chunkW = w;
          } else {
            chunk += ch;
            chunkW += w;
          }
        }
        current = chunk;
        currentWidth = chunkW;
      }
    } else if (currentWidth + 1 + wordWidth <= safeWidth) {
      current += ` ${word}`;
      currentWidth += 1 + wordWidth;
    } else {
      lines.push(current);
      current = word;
      currentWidth = wordWidth;
    }
  }

  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * Quebra uma string já estilizada com códigos ANSI SGR em múltiplas linhas de no máximo
 * `maxWidth` colunas visíveis, preservando e restaurando os estilos ativos entre quebras.
 */
export function wrapAnsi(styledText: string, maxWidth: number): string[] {
  const safeWidth = Math.max(8, maxWidth);
  const tokens: Array<{ text: string; width: number; activeAfter: string; isSpace: boolean }> = [];
  let activeSgr = '';
  let i = 0;

  while (i < styledText.length) {
    let chunk = '';
    let chunkW = 0;
    let isSpace = false;

    // Captura sequências SGR no início do token
    while (i < styledText.length && styledText[i] === '\x1b' && styledText[i + 1] === '[') {
      const end = styledText.indexOf('m', i);
      if (end === -1) break;
      const seq = styledText.slice(i, end + 1);
      chunk += seq;
      activeSgr = seq === RESET ? '' : activeSgr + seq;
      i = end + 1;
    }
    if (i >= styledText.length) {
      if (chunk) tokens.push({ text: chunk, width: 0, activeAfter: activeSgr, isSpace: false });
      break;
    }

    if (styledText[i] === ' ') {
      isSpace = true;
      while (i < styledText.length && styledText[i] === ' ') {
        chunk += ' ';
        chunkW++;
        i++;
      }
      tokens.push({ text: chunk, width: chunkW, activeAfter: activeSgr, isSpace: true });
    } else {
      while (i < styledText.length && styledText[i] !== ' ') {
        if (styledText[i] === '\x1b' && styledText[i + 1] === '[') {
          const end = styledText.indexOf('m', i);
          if (end !== -1) {
            const seq = styledText.slice(i, end + 1);
            chunk += seq;
            activeSgr = seq === RESET ? '' : activeSgr + seq;
            i = end + 1;
            continue;
          }
        }
        const cp = styledText.codePointAt(i) ?? 0;
        const ch = String.fromCodePoint(cp);
        chunk += ch;
        chunkW += charDisplayWidth(cp);
        i += ch.length;
      }
      tokens.push({ text: chunk, width: chunkW, activeAfter: activeSgr, isSpace: false });
    }
  }

  const lines: string[] = [];
  let line = '';
  let lineW = 0;
  let lineStyle = '';

  for (const tok of tokens) {
    if (tok.isSpace && lineW === 0) {
      lineStyle = tok.activeAfter;
      continue;
    }
    if (lineW > 0 && !tok.isSpace && lineW + tok.width > safeWidth) {
      lines.push(`${line}${lineStyle ? RESET : ''}`);
      line = `${lineStyle}${tok.text}`;
      lineW = tok.width;
      lineStyle = tok.activeAfter;
    } else {
      line += tok.text;
      lineW += tok.width;
      lineStyle = tok.activeAfter;
    }
  }

  if (line.length > 0 || lines.length === 0) {
    lines.push(`${line}${lineStyle ? RESET : ''}`);
  }
  return lines;
}

/** Aplica destaque visual a todas as ocorrências case-insensitive de `query` em uma linha. */
export function highlightSearch(
  line: string,
  query: string,
  matchBg: RgbColor,
  matchFg: RgbColor
): { text: string; matches: number } {
  const cleanQuery = query.trim();
  if (!cleanQuery) return { text: line, matches: 0 };

  const plain = stripAnsi(line);
  const lowerPlain = plain.toLowerCase();
  const lowerQuery = cleanQuery.toLowerCase();
  if (!lowerPlain.includes(lowerQuery)) return { text: line, matches: 0 };

  let result = '';
  let pos = 0;
  let matches = 0;
  const startStyle = `${bg(matchBg)}${fg(matchFg)}${BOLD}`;

  while (pos < plain.length) {
    const idx = lowerPlain.indexOf(lowerQuery, pos);
    if (idx === -1) {
      result += plain.slice(pos);
      break;
    }
    result += plain.slice(pos, idx);
    result += `${startStyle}${plain.slice(idx, idx + cleanQuery.length)}${RESET}`;
    matches++;
    pos = idx + cleanQuery.length;
  }

  return { text: result, matches };
}

export function styleText(text: string, color: RgbColor, extra = ''): string {
  return `${extra}${fg(color)}${text}${RESET}`;
}

/**
 * VimView — Renderizador de Frame ANSI para o Editor Modal Vim (SPEC-002)
 * Renderiza cabeçalho, gutter de linhas, syntax highlighting seguro com cursor,
 * seleção Visual/Visual-Line, destaque de busca e barra inferior modal nos 3 temas oficiais.
 */

import path from 'node:path';
import { detectLanguageFromPath, highlightCodeLine, type CodeLanguage } from '../renderers/code.js';
import { bg, fg, type RgbColor, type ThemePalette } from '../themes/palette.js';
import { BOLD, DIM, RESET, fitAnsi, stripUnsafeAnsi, visibleLength } from '../tui/ansi.js';
import type { SelectionRange } from './vimBuffer.js';
import type { VimEngine, VimMode } from './vimEngine.js';

export interface EditorViewport {
  scrollY: number;
  scrollX: number;
}

export interface EditorFrameInput {
  readonly engine: VimEngine;
  readonly filePath: string;
  readonly width: number;
  readonly height: number;
  readonly theme: ThemePalette;
  readonly viewport: EditorViewport;
  readonly statusMessage: string;
  readonly statusIsError: boolean;
}

interface ModeBadge {
  readonly label: string;
  readonly bgColor: RgbColor;
  readonly fgColor: RgbColor;
}

function getModeBadge(mode: VimMode, theme: ThemePalette): ModeBadge {
  switch (mode) {
    case 'insert':
      return { label: ' INSERT ', bgColor: theme.success, fgColor: theme.statusBg };
    case 'visual':
      return { label: ' VISUAL ', bgColor: theme.accentAlt, fgColor: theme.statusBg };
    case 'visual-line':
      return { label: ' V-LINE ', bgColor: theme.accentAlt, fgColor: theme.statusBg };
    case 'command':
      return { label: ' COMMAND ', bgColor: theme.warning, fgColor: theme.statusBg };
    case 'search':
      return { label: ' SEARCH ', bgColor: theme.searchBg, fgColor: theme.searchFg };
    case 'normal':
    default:
      return { label: ' NORMAL ', bgColor: theme.accent, fgColor: theme.statusBg };
  }
}

function isInSelection(line: number, col: number, sel: SelectionRange | null, mode: VimMode): boolean {
  if (!sel) return false;
  if (line < sel.start.line || line > sel.end.line) return false;
  if (mode === 'visual-line') return true;
  if (sel.start.line === sel.end.line) {
    return col >= sel.start.col && col <= sel.end.col;
  }
  if (line === sel.start.line) return col >= sel.start.col;
  if (line === sel.end.line) return col <= sel.end.col;
  return true;
}

function renderInteractiveLine(
  rawLine: string,
  lineIdx: number,
  scrollX: number,
  contentW: number,
  lang: CodeLanguage,
  engine: VimEngine,
  selection: SelectionRange | null,
  theme: ThemePalette
): string {
  const safeLine = stripUnsafeAnsi(rawLine);
  const isCursorLine = lineIdx === engine.buffer.cursor.line;
  const cursorCol = engine.buffer.cursor.col;
  const hasSelectionOnLine =
    selection !== null && lineIdx >= selection.start.line && lineIdx <= selection.end.line;

  const query = engine.searchQuery.trim().toLowerCase();
  const hasSearchOnLine = query.length > 0 && safeLine.toLowerCase().includes(query);

  // Caminho rápido com syntax highlighting completo para linhas sem cursor/seleção/busca
  if (!isCursorLine && !hasSelectionOnLine && !hasSearchOnLine) {
    const visibleSlice = safeLine.slice(scrollX, scrollX + contentW);
    return fitAnsi(highlightCodeLine(visibleSlice, lang, theme), contentW);
  }

  // Calcula intervalos de busca na linha
  const searchFlags = new Uint8Array(safeLine.length);
  if (hasSearchOnLine) {
    const lower = safeLine.toLowerCase();
    let pos = 0;
    while (pos < lower.length) {
      const idx = lower.indexOf(query, pos);
      if (idx === -1) break;
      for (let k = idx; k < idx + query.length && k < searchFlags.length; k++) {
        searchFlags[k] = 1;
      }
      pos = idx + query.length;
    }
  }

  // Renderização caractere-a-caractere com cursor + seleção + busca
  const endCol = scrollX + contentW;
  let out = '';
  for (let col = scrollX; col < endCol; col++) {
    const ch = col < safeLine.length ? (safeLine[col] ?? ' ') : ' ';
    const atCursor = isCursorLine && col === cursorCol;

    if (atCursor) {
      const cursorBg = engine.mode === 'insert' ? theme.success : theme.accent;
      out += `${bg(cursorBg)}${fg(theme.statusBg)}${BOLD}${ch}${RESET}`;
    } else if (col < safeLine.length && isInSelection(lineIdx, col, selection, engine.mode)) {
      out += `${bg(theme.selectionBg)}${fg(theme.selectionFg)}${ch}${RESET}`;
    } else if (col < safeLine.length && searchFlags[col] === 1) {
      out += `${bg(theme.searchBg)}${fg(theme.searchFg)}${BOLD}${ch}${RESET}`;
    } else if (col < safeLine.length) {
      out += `${fg(theme.text)}${ch}${RESET}`;
    } else {
      out += ' ';
    }
  }
  return out;
}

export function syncEditorViewport(
  engine: VimEngine,
  viewport: EditorViewport,
  width: number,
  height: number
): void {
  const bodyHeight = Math.max(4, height - 2);
  const gutterDigits = Math.max(3, String(engine.buffer.lines.length).length);
  const gutterW = engine.showLineNumbers ? gutterDigits + 3 : 1;
  const contentW = Math.max(10, width - gutterW);

  if (engine.buffer.cursor.line < viewport.scrollY) {
    viewport.scrollY = engine.buffer.cursor.line;
  } else if (engine.buffer.cursor.line >= viewport.scrollY + bodyHeight) {
    viewport.scrollY = engine.buffer.cursor.line - bodyHeight + 1;
  }

  if (engine.buffer.cursor.col < viewport.scrollX) {
    viewport.scrollX = engine.buffer.cursor.col;
  } else if (engine.buffer.cursor.col >= viewport.scrollX + contentW - 1) {
    viewport.scrollX = Math.max(0, engine.buffer.cursor.col - contentW + 2);
  }
}

export function buildEditorFrame(input: EditorFrameInput): string[] {
  const { engine, filePath, width, height, theme, viewport, statusMessage, statusIsError } = input;
  const bodyHeight = Math.max(4, height - 2);
  const totalLines = engine.buffer.lines.length;
  const lang = detectLanguageFromPath(filePath);
  const selection = engine.getSelectionRange();

  syncEditorViewport(engine, viewport, width, height);

  // Cabeçalho superior
  const fileName = stripUnsafeAnsi(path.basename(filePath));
  const dirtyFlag = engine.buffer.dirty ? ` ${fg(theme.warning)}[+]${RESET}` : '';
  const pct = totalLines <= 1 ? '100%' : `${Math.round(((engine.buffer.cursor.line + 1) / totalLines) * 100)}%`;
  const left = `${bg(theme.headerBg)}${fg(theme.accent)}${BOLD} ◈ VIM ${RESET}${bg(theme.headerBg)}${fg(theme.headerFg)}${BOLD} ${fileName}${dirtyFlag}${bg(theme.headerBg)} ${RESET}`;
  const right = `${bg(theme.headerBg)}${fg(theme.accentAlt)}${BOLD}[${lang.toUpperCase()}]${RESET}${bg(theme.headerBg)}${fg(theme.muted)} Ln ${engine.buffer.cursor.line + 1}, Col ${engine.buffer.cursor.col + 1} · ${pct} ${RESET}`;
  const fill = `${bg(theme.headerBg)}${' '.repeat(Math.max(0, width - visibleLength(left) - visibleLength(right)))}${RESET}`;

  const rows: string[] = [`${left}${fill}${right}`];

  const gutterDigits = Math.max(3, String(totalLines).length);
  const gutterW = engine.showLineNumbers ? gutterDigits + 3 : 1;
  const contentW = Math.max(10, width - gutterW);

  for (let r = 0; r < bodyHeight; r++) {
    const lineIdx = viewport.scrollY + r;
    if (lineIdx >= totalLines) {
      const tilde = `${fg(theme.muted)}${DIM} ~${RESET}`;
      rows.push(fitAnsi(tilde, width));
      continue;
    }

    const isCur = lineIdx === engine.buffer.cursor.line;
    const gutter = engine.showLineNumbers
      ? `${fg(isCur ? theme.accent : theme.muted)}${isCur ? BOLD : DIM}${String(lineIdx + 1).padStart(gutterDigits, ' ')} │${RESET} `
      : ' ';

    const body = renderInteractiveLine(
      engine.buffer.lines[lineIdx] ?? '',
      lineIdx,
      viewport.scrollX,
      contentW,
      lang,
      engine,
      selection,
      theme
    );
    rows.push(`${gutter}${body}`);
  }

  // Barra inferior modal estilo Vim
  const badge = getModeBadge(engine.mode, theme);
  const modePill = `${bg(badge.bgColor)}${fg(badge.fgColor)}${BOLD}${badge.label}${RESET}`;

  let footerCenter = '';
  if (engine.mode === 'command') {
    footerCenter = ` :${stripUnsafeAnsi(engine.commandInput)}█`;
  } else if (engine.mode === 'search') {
    footerCenter = ` /${stripUnsafeAnsi(engine.commandInput)}█`;
  } else if (statusMessage) {
    const msgColor = statusIsError ? theme.danger : theme.warning;
    footerCenter = ` ${fg(msgColor)}${BOLD}${stripUnsafeAnsi(statusMessage)}${RESET}${bg(theme.statusBg)}`;
  } else if (engine.mode === 'insert') {
    footerCenter = ' -- INSERT --  Esc Normal · Tab Indentar';
  } else if (engine.mode === 'visual' || engine.mode === 'visual-line') {
    footerCenter = ' -- VISUAL --  y Copiar · d Deletar · c Alterar · Esc Cancelar';
  } else {
    footerCenter = ' i Inserir · v/V Visual · / Buscar · u/Ctrl+R Undo/Redo · :w Salvar · :wq Sair · :q!';
  }

  const pending = `${engine.countPrefix}${engine.pendingOperator}`;
  const pendingPill = pending ? ` ${fg(theme.accent)}${BOLD}${pending}${RESET}${bg(theme.statusBg)} ` : ' ';
  const avail = Math.max(0, width - visibleLength(modePill) - visibleLength(pendingPill));
  const styledCenter = `${bg(theme.statusBg)}${fg(theme.statusFg)}${fitAnsi(footerCenter, avail)}${RESET}`;
  rows.push(`${modePill}${styledCenter}${bg(theme.statusBg)}${pendingPill}${RESET}`);

  return rows;
}

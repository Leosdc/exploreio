/**
 * VimBuffer — Estrutura de dados do buffer de texto do editor modal (SPEC-002)
 * Gerencia linhas, cursor, seleção visual, histórico Undo/Redo, register, busca e EOL.
 */

export type EolStyle = '\n' | '\r\n';

export interface CursorPos {
  line: number;
  col: number;
}

export interface SelectionRange {
  start: CursorPos;
  end: CursorPos;
}

export interface VimRegister {
  text: string;
  linewise: boolean;
}

export interface BufferSnapshot {
  lines: string[];
  cursor: CursorPos;
}

export interface SearchMatch {
  line: number;
  col: number;
  length: number;
}

const WORD_CHAR_RE = /[A-Za-z0-9_À-ÖØ-öø-ÿ]/;

function isWordChar(ch: string): boolean {
  return WORD_CHAR_RE.test(ch);
}

export function comparePos(a: CursorPos, b: CursorPos): number {
  if (a.line !== b.line) return a.line - b.line;
  return a.col - b.col;
}

export function normalizeRange(a: CursorPos, b: CursorPos): SelectionRange {
  return comparePos(a, b) <= 0
    ? { start: { ...a }, end: { ...b } }
    : { start: { ...b }, end: { ...a } };
}

export class VimBuffer {
  public lines: string[];
  public cursor: CursorPos = { line: 0, col: 0 };
  public readonly eol: EolStyle;
  public dirty = false;
  public register: VimRegister = { text: '', linewise: false };

  private undoStack: BufferSnapshot[] = [];
  private redoStack: BufferSnapshot[] = [];
  private readonly maxHistory = 200;

  constructor(rawText: string) {
    this.eol = rawText.includes('\r\n') ? '\r\n' : '\n';
    const normalized = rawText.replace(/\r\n/g, '\n');
    this.lines = normalized.length === 0 ? [''] : normalized.split('\n');
  }

  public toText(): string {
    return this.lines.join(this.eol);
  }

  public currentLine(): string {
    return this.lines[this.cursor.line] ?? '';
  }

  public clampCursor(allowLineEnd: boolean): void {
    this.cursor.line = Math.max(0, Math.min(this.cursor.line, this.lines.length - 1));
    const lineLen = this.lines[this.cursor.line]?.length ?? 0;
    const maxCol = allowLineEnd ? lineLen : Math.max(0, lineLen - 1);
    this.cursor.col = Math.max(0, Math.min(this.cursor.col, maxCol));
  }

  public pushUndo(): void {
    this.undoStack.push({
      lines: [...this.lines],
      cursor: { ...this.cursor },
    });
    if (this.undoStack.length > this.maxHistory) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  public undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push({ lines: [...this.lines], cursor: { ...this.cursor } });
    this.lines = prev.lines;
    this.cursor = prev.cursor;
    this.dirty = true;
    this.clampCursor(false);
    return true;
  }

  public redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push({ lines: [...this.lines], cursor: { ...this.cursor } });
    this.lines = next.lines;
    this.cursor = next.cursor;
    this.dirty = true;
    this.clampCursor(false);
    return true;
  }

  public insertText(text: string): void {
    const line = this.currentLine();
    const col = Math.min(this.cursor.col, line.length);
    this.lines[this.cursor.line] = `${line.slice(0, col)}${text}${line.slice(col)}`;
    this.cursor.col = col + text.length;
    this.dirty = true;
  }

  public insertNewline(): void {
    const line = this.currentLine();
    const col = Math.min(this.cursor.col, line.length);
    const before = line.slice(0, col);
    const after = line.slice(col);
    const indent = before.match(/^(\s*)/)?.[1] ?? '';
    this.lines[this.cursor.line] = before;
    this.lines.splice(this.cursor.line + 1, 0, `${indent}${after}`);
    this.cursor.line += 1;
    this.cursor.col = indent.length;
    this.dirty = true;
  }

  public backspace(): void {
    if (this.cursor.col > 0) {
      const line = this.currentLine();
      this.lines[this.cursor.line] = `${line.slice(0, this.cursor.col - 1)}${line.slice(this.cursor.col)}`;
      this.cursor.col -= 1;
      this.dirty = true;
      return;
    }
    if (this.cursor.line > 0) {
      const prevLine = this.lines[this.cursor.line - 1] ?? '';
      const currLine = this.currentLine();
      const joinCol = prevLine.length;
      this.lines[this.cursor.line - 1] = `${prevLine}${currLine}`;
      this.lines.splice(this.cursor.line, 1);
      this.cursor.line -= 1;
      this.cursor.col = joinCol;
      this.dirty = true;
    }
  }

  public deleteCharAt(allowJoinNext: boolean): boolean {
    const line = this.currentLine();
    if (this.cursor.col < line.length) {
      const removed = line[this.cursor.col] ?? '';
      this.lines[this.cursor.line] = `${line.slice(0, this.cursor.col)}${line.slice(this.cursor.col + 1)}`;
      this.register = { text: removed, linewise: false };
      this.dirty = true;
      this.clampCursor(allowJoinNext);
      return true;
    }
    if (allowJoinNext && this.cursor.line < this.lines.length - 1) {
      const nextLine = this.lines[this.cursor.line + 1] ?? '';
      this.lines[this.cursor.line] = `${line}${nextLine}`;
      this.lines.splice(this.cursor.line + 1, 1);
      this.dirty = true;
      return true;
    }
    return false;
  }

  public replaceCharAt(ch: string): boolean {
    const line = this.currentLine();
    if (this.cursor.col >= line.length) return false;
    this.pushUndo();
    this.lines[this.cursor.line] = `${line.slice(0, this.cursor.col)}${ch}${line.slice(this.cursor.col + 1)}`;
    this.dirty = true;
    return true;
  }

  public deleteLines(startLine: number, count: number): number {
    const start = Math.max(0, Math.min(startLine, this.lines.length - 1));
    const safeCount = Math.max(1, Math.min(count, this.lines.length - start));
    this.pushUndo();
    const removed = this.lines.splice(start, safeCount);
    this.register = { text: removed.join('\n'), linewise: true };
    if (this.lines.length === 0) {
      this.lines = [''];
    }
    this.cursor.line = Math.min(start, this.lines.length - 1);
    this.clampCursor(false);
    this.dirty = true;
    return removed.length;
  }

  public yankLines(startLine: number, count: number): number {
    const start = Math.max(0, Math.min(startLine, this.lines.length - 1));
    const safeCount = Math.max(1, Math.min(count, this.lines.length - start));
    const slice = this.lines.slice(start, start + safeCount);
    this.register = { text: slice.join('\n'), linewise: true };
    return slice.length;
  }

  public yankCharRange(a: CursorPos, b: CursorPos): string {
    const { start, end } = normalizeRange(a, b);
    if (start.line === end.line) {
      const line = this.lines[start.line] ?? '';
      const text = line.slice(start.col, end.col + 1);
      this.register = { text, linewise: false };
      return text;
    }
    const parts: string[] = [];
    parts.push((this.lines[start.line] ?? '').slice(start.col));
    for (let l = start.line + 1; l < end.line; l++) {
      parts.push(this.lines[l] ?? '');
    }
    parts.push((this.lines[end.line] ?? '').slice(0, end.col + 1));
    const text = parts.join('\n');
    this.register = { text, linewise: false };
    return text;
  }

  public deleteCharRange(a: CursorPos, b: CursorPos): void {
    const { start, end } = normalizeRange(a, b);
    this.yankCharRange(start, end);
    this.pushUndo();
    const startLine = this.lines[start.line] ?? '';
    const endLine = this.lines[end.line] ?? '';
    const prefix = startLine.slice(0, start.col);
    const suffix = endLine.slice(end.col + 1);
    this.lines.splice(start.line, end.line - start.line + 1, `${prefix}${suffix}`);
    this.cursor = { line: start.line, col: start.col };
    this.clampCursor(false);
    this.dirty = true;
  }

  public paste(before: boolean): boolean {
    if (!this.register.text) return false;
    this.pushUndo();
    if (this.register.linewise) {
      const toInsert = this.register.text.split('\n');
      const insertAt = before ? this.cursor.line : this.cursor.line + 1;
      this.lines.splice(insertAt, 0, ...toInsert);
      this.cursor.line = insertAt;
      this.cursor.col = this.firstNonWhitespaceCol(insertAt);
      this.dirty = true;
      return true;
    }

    const line = this.currentLine();
    const col = before ? this.cursor.col : Math.min(line.length, this.cursor.col + 1);
    const parts = this.register.text.split('\n');
    if (parts.length === 1) {
      const txt = parts[0] ?? '';
      this.lines[this.cursor.line] = `${line.slice(0, col)}${txt}${line.slice(col)}`;
      this.cursor.col = Math.max(0, col + txt.length - 1);
    } else {
      const first = parts[0] ?? '';
      const last = parts[parts.length - 1] ?? '';
      const middle = parts.slice(1, -1);
      const newLines = [`${line.slice(0, col)}${first}`, ...middle, `${last}${line.slice(col)}`];
      this.lines.splice(this.cursor.line, 1, ...newLines);
      this.cursor.line += parts.length - 1;
      this.cursor.col = Math.max(0, last.length - 1);
    }
    this.clampCursor(false);
    this.dirty = true;
    return true;
  }

  public openLine(above: boolean): void {
    this.pushUndo();
    const indent = this.currentLine().match(/^(\s*)/)?.[1] ?? '';
    const insertAt = above ? this.cursor.line : this.cursor.line + 1;
    this.lines.splice(insertAt, 0, indent);
    this.cursor = { line: insertAt, col: indent.length };
    this.dirty = true;
  }

  public joinNextLine(): boolean {
    if (this.cursor.line >= this.lines.length - 1) return false;
    this.pushUndo();
    const curr = this.currentLine();
    const next = (this.lines[this.cursor.line + 1] ?? '').trimStart();
    const joinCol = curr.length;
    this.lines[this.cursor.line] = next ? `${curr}${curr.endsWith(' ') || !curr ? '' : ' '}${next}` : curr;
    this.lines.splice(this.cursor.line + 1, 1);
    this.cursor.col = Math.min(joinCol, Math.max(0, (this.lines[this.cursor.line]?.length ?? 1) - 1));
    this.dirty = true;
    return true;
  }

  public firstNonWhitespaceCol(lineIdx = this.cursor.line): number {
    const line = this.lines[lineIdx] ?? '';
    const idx = line.search(/\S/);
    return idx >= 0 ? idx : 0;
  }

  public moveWordForward(): void {
    let { line, col } = this.cursor;
    const curr = this.lines[line] ?? '';
    if (col < curr.length) {
      if (isWordChar(curr[col] ?? '')) {
        while (col < curr.length && isWordChar(curr[col] ?? '')) col++;
      } else if (!/\s/.test(curr[col] ?? '')) {
        while (col < curr.length && !isWordChar(curr[col] ?? '') && !/\s/.test(curr[col] ?? '')) col++;
      }
      while (col < curr.length && /\s/.test(curr[col] ?? '')) col++;
      if (col < curr.length) {
        this.cursor = { line, col };
        return;
      }
    }
    if (line < this.lines.length - 1) {
      line += 1;
      this.cursor = { line, col: this.firstNonWhitespaceCol(line) };
    }
  }

  public moveWordBackward(): void {
    let { line, col } = this.cursor;
    if (col === 0) {
      if (line === 0) return;
      line -= 1;
      col = Math.max(0, (this.lines[line]?.length ?? 1) - 1);
      this.cursor = { line, col };
      return;
    }
    const curr = this.lines[line] ?? '';
    col = Math.min(col - 1, curr.length - 1);
    while (col > 0 && /\s/.test(curr[col] ?? '')) col--;
    if (isWordChar(curr[col] ?? '')) {
      while (col > 0 && isWordChar(curr[col - 1] ?? '')) col--;
    } else {
      while (col > 0 && !isWordChar(curr[col - 1] ?? '') && !/\s/.test(curr[col - 1] ?? '')) col--;
    }
    this.cursor = { line, col };
  }

  public moveWordEnd(): void {
    let { line, col } = this.cursor;
    let curr = this.lines[line] ?? '';
    if (col + 1 >= curr.length) {
      if (line >= this.lines.length - 1) return;
      line += 1;
      curr = this.lines[line] ?? '';
      col = 0;
    } else {
      col += 1;
    }
    while (col < curr.length && /\s/.test(curr[col] ?? '')) col++;
    if (col < curr.length) {
      if (isWordChar(curr[col] ?? '')) {
        while (col + 1 < curr.length && isWordChar(curr[col + 1] ?? '')) col++;
      } else {
        while (col + 1 < curr.length && !isWordChar(curr[col + 1] ?? '') && !/\s/.test(curr[col + 1] ?? '')) {
          col++;
        }
      }
    }
    this.cursor = { line, col: Math.min(col, Math.max(0, curr.length - 1)) };
  }

  public findAllMatches(query: string): SearchMatch[] {
    const clean = query.trim();
    if (!clean) return [];
    const lowerQ = clean.toLowerCase();
    const matches: SearchMatch[] = [];
    for (let l = 0; l < this.lines.length; l++) {
      const lowerLine = (this.lines[l] ?? '').toLowerCase();
      let pos = 0;
      while (pos < lowerLine.length) {
        const idx = lowerLine.indexOf(lowerQ, pos);
        if (idx === -1) break;
        matches.push({ line: l, col: idx, length: clean.length });
        pos = idx + clean.length;
      }
    }
    return matches;
  }
}

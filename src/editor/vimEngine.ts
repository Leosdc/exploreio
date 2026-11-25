/**
 * VimEngine — Máquina de estados modal estilo Vim para o Exploreio (SPEC-002)
 * Suporta modos NORMAL, INSERT, VISUAL, VISUAL_LINE, COMMAND e SEARCH.
 */

import type { KeyEvent } from '../tui/input.js';
import { comparePos, normalizeRange, type CursorPos, type SearchMatch, type SelectionRange, VimBuffer } from './vimBuffer.js';

export type VimMode = 'normal' | 'insert' | 'visual' | 'visual-line' | 'command' | 'search';

export interface VimEngineAction {
  type: 'none' | 'save' | 'quit' | 'save-and-quit' | 'force-quit';
  message?: string;
  isError?: boolean;
}

export class VimEngine {
  public readonly buffer: VimBuffer;
  public mode: VimMode = 'normal';
  public commandInput = '';
  public searchQuery = '';
  public searchMatches: SearchMatch[] = [];
  public visualAnchor: CursorPos | null = null;
  public pendingOperator = '';
  public countPrefix = '';
  public showLineNumbers = true;

  private insertSnapshotTaken = false;

  constructor(initialText: string) {
    this.buffer = new VimBuffer(initialText);
  }

  public getSelectionRange(): SelectionRange | null {
    if (!this.visualAnchor) return null;
    if (this.mode === 'visual') {
      return normalizeRange(this.visualAnchor, this.buffer.cursor);
    }
    if (this.mode === 'visual-line') {
      const startLine = Math.min(this.visualAnchor.line, this.buffer.cursor.line);
      const endLine = Math.max(this.visualAnchor.line, this.buffer.cursor.line);
      const endCol = Math.max(0, (this.buffer.lines[endLine]?.length ?? 1) - 1);
      return { start: { line: startLine, col: 0 }, end: { line: endLine, col: endCol } };
    }
    return null;
  }

  public handleKey(ev: KeyEvent, pageSize = 20): VimEngineAction {
    switch (this.mode) {
      case 'insert':
        return this.handleInsertKey(ev);
      case 'command':
        return this.handleCommandKey(ev);
      case 'search':
        return this.handleSearchKey(ev);
      case 'visual':
      case 'visual-line':
        return this.handleVisualKey(ev, pageSize);
      case 'normal':
      default:
        return this.handleNormalKey(ev, pageSize);
    }
  }

  private consumeCount(): number {
    const parsed = this.countPrefix ? Number.parseInt(this.countPrefix, 10) : 1;
    this.countPrefix = '';
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : 1;
  }

  private enterInsertMode(takeSnapshot = true): void {
    this.mode = 'insert';
    this.pendingOperator = '';
    this.countPrefix = '';
    this.visualAnchor = null;
    this.insertSnapshotTaken = false;
    if (takeSnapshot) {
      this.buffer.pushUndo();
      this.insertSnapshotTaken = true;
    }
  }

  private handleNormalKey(ev: KeyEvent, pageSize: number): VimEngineAction {
    if (ev.name === 'escape') {
      this.pendingOperator = '';
      this.countPrefix = '';
      return { type: 'none' };
    }

    // Operador `r<char>`: substitui caractere sob o cursor
    if (this.pendingOperator === 'r') {
      this.pendingOperator = '';
      this.countPrefix = '';
      if (ev.char) {
        this.buffer.replaceCharAt(ev.char);
      }
      return { type: 'none' };
    }

    // Prefixo numérico (ex.: 5j, 3dd)
    if (!this.pendingOperator && ev.char && /^[1-9]$/.test(ev.char)) {
      this.countPrefix += ev.char;
      return { type: 'none' };
    }
    if (!this.pendingOperator && this.countPrefix && ev.char === '0') {
      this.countPrefix += '0';
      return { type: 'none' };
    }

    // Operadores compostos de 2 teclas (gg, dd, yy, cc)
    if (this.pendingOperator) {
      return this.handlePendingOperator(ev);
    }

    // Controles Ctrl+R (Redo), Ctrl+D / Ctrl+U (meia página)
    if (ev.ctrl && ev.name === 'r') {
      this.countPrefix = '';
      return {
        type: 'none',
        message: this.buffer.redo() ? 'Refeito (Redo)' : 'Nada para refazer',
      };
    }
    if (ev.ctrl && ev.name === 'd') {
      const half = Math.max(4, Math.floor(pageSize / 2));
      this.buffer.cursor.line += half * this.consumeCount();
      this.buffer.clampCursor(false);
      return { type: 'none' };
    }
    if (ev.ctrl && ev.name === 'u') {
      const half = Math.max(4, Math.floor(pageSize / 2));
      this.buffer.cursor.line -= half * this.consumeCount();
      this.buffer.clampCursor(false);
      return { type: 'none' };
    }

    // Motions de navegação
    if (this.tryHandleMotion(ev, pageSize)) {
      return { type: 'none' };
    }

    // Entradas em INSERT
    if (ev.char === 'i') {
      this.enterInsertMode();
      return { type: 'none' };
    }
    if (ev.char === 'I') {
      this.buffer.cursor.col = this.buffer.firstNonWhitespaceCol();
      this.enterInsertMode();
      return { type: 'none' };
    }
    if (ev.char === 'a') {
      const len = this.buffer.currentLine().length;
      if (len > 0) this.buffer.cursor.col = Math.min(len, this.buffer.cursor.col + 1);
      this.enterInsertMode();
      return { type: 'none' };
    }
    if (ev.char === 'A') {
      this.buffer.cursor.col = this.buffer.currentLine().length;
      this.enterInsertMode();
      return { type: 'none' };
    }
    if (ev.char === 'o') {
      this.buffer.openLine(false);
      this.enterInsertMode(false);
      return { type: 'none' };
    }
    if (ev.char === 'O') {
      this.buffer.openLine(true);
      this.enterInsertMode(false);
      return { type: 'none' };
    }

    // Modos VISUAL, COMMAND e SEARCH
    if (ev.char === 'v') {
      this.mode = 'visual';
      this.visualAnchor = { ...this.buffer.cursor };
      this.countPrefix = '';
      return { type: 'none' };
    }
    if (ev.char === 'V') {
      this.mode = 'visual-line';
      this.visualAnchor = { ...this.buffer.cursor };
      this.countPrefix = '';
      return { type: 'none' };
    }
    if (ev.char === ':') {
      this.mode = 'command';
      this.commandInput = '';
      this.countPrefix = '';
      return { type: 'none' };
    }
    if (ev.char === '/') {
      this.mode = 'search';
      this.commandInput = '';
      this.countPrefix = '';
      return { type: 'none' };
    }

    // Operadores diretos em NORMAL
    if (ev.char === 'g' || ev.char === 'd' || ev.char === 'y' || ev.char === 'c' || ev.char === 'r') {
      this.pendingOperator = ev.char;
      return { type: 'none' };
    }
    if (ev.char === 'x' || ev.name === 'delete') {
      const count = this.consumeCount();
      this.buffer.pushUndo();
      for (let i = 0; i < count; i++) {
        this.buffer.deleteCharAt(false);
      }
      return { type: 'none' };
    }
    if (ev.char === 'D') {
      const line = this.buffer.currentLine();
      this.countPrefix = '';
      if (this.buffer.cursor.col < line.length) {
        this.buffer.pushUndo();
        this.buffer.register = { text: line.slice(this.buffer.cursor.col), linewise: false };
        this.buffer.lines[this.buffer.cursor.line] = line.slice(0, this.buffer.cursor.col);
        this.buffer.dirty = true;
        this.buffer.clampCursor(false);
      }
      return { type: 'none' };
    }
    if (ev.char === 'C') {
      const line = this.buffer.currentLine();
      this.countPrefix = '';
      this.buffer.pushUndo();
      this.buffer.register = { text: line.slice(this.buffer.cursor.col), linewise: false };
      this.buffer.lines[this.buffer.cursor.line] = line.slice(0, this.buffer.cursor.col);
      this.buffer.dirty = true;
      this.enterInsertMode(false);
      return { type: 'none' };
    }
    if (ev.char === 'p' || ev.char === 'P') {
      const count = this.consumeCount();
      let pasted = false;
      for (let i = 0; i < count; i++) {
        pasted = this.buffer.paste(ev.char === 'P') || pasted;
      }
      return { type: 'none', message: pasted ? undefined : 'Register vazio' };
    }
    if (ev.char === 'u') {
      this.countPrefix = '';
      return {
        type: 'none',
        message: this.buffer.undo() ? 'Desfeito (Undo)' : 'Já está na alteração mais antiga',
      };
    }
    if (ev.char === 'J') {
      this.countPrefix = '';
      this.buffer.joinNextLine();
      return { type: 'none' };
    }
    if (ev.char === 'n' || ev.char === 'N') {
      this.countPrefix = '';
      return this.jumpSearchMatch(ev.char === 'N');
    }

    this.countPrefix = '';
    return { type: 'none' };
  }

  private handlePendingOperator(ev: KeyEvent): VimEngineAction {
    const op = this.pendingOperator;
    this.pendingOperator = '';

    if (op === 'g' && ev.char === 'g') {
      const targetLine = this.countPrefix ? Math.max(0, this.consumeCount() - 1) : 0;
      this.buffer.cursor.line = Math.min(targetLine, this.buffer.lines.length - 1);
      this.buffer.cursor.col = this.buffer.firstNonWhitespaceCol();
      return { type: 'none' };
    }
    if (op === 'd' && ev.char === 'd') {
      const removed = this.buffer.deleteLines(this.buffer.cursor.line, this.consumeCount());
      return { type: 'none', message: `${removed} linha(s) removida(s)` };
    }
    if (op === 'y' && ev.char === 'y') {
      const yanked = this.buffer.yankLines(this.buffer.cursor.line, this.consumeCount());
      return { type: 'none', message: `${yanked} linha(s) copiada(s)` };
    }
    if (op === 'c' && ev.char === 'c') {
      const count = this.consumeCount();
      const indent = this.buffer.currentLine().match(/^(\s*)/)?.[1] ?? '';
      this.buffer.pushUndo();
      const start = this.buffer.cursor.line;
      const safeCount = Math.min(count, this.buffer.lines.length - start);
      const removed = this.buffer.lines.splice(start, safeCount, indent);
      this.buffer.register = { text: removed.join('\n'), linewise: true };
      this.buffer.cursor = { line: start, col: indent.length };
      this.buffer.dirty = true;
      this.enterInsertMode(false);
      return { type: 'none' };
    }

    this.countPrefix = '';
    return { type: 'none' };
  }

  private tryHandleMotion(ev: KeyEvent, pageSize: number): boolean {
    if (ev.name === 'left' || ev.char === 'h') {
      this.buffer.cursor.col = Math.max(0, this.buffer.cursor.col - this.consumeCount());
      return true;
    }
    if (ev.name === 'right' || ev.char === 'l') {
      this.buffer.cursor.col += this.consumeCount();
      this.buffer.clampCursor(false);
      return true;
    }
    if (ev.name === 'up' || ev.char === 'k' || ev.name === 'wheel_up') {
      const step = ev.name === 'wheel_up' ? 3 : this.consumeCount();
      this.buffer.cursor.line = Math.max(0, this.buffer.cursor.line - step);
      this.buffer.clampCursor(false);
      return true;
    }
    if (ev.name === 'down' || ev.char === 'j' || ev.name === 'wheel_down') {
      const step = ev.name === 'wheel_down' ? 3 : this.consumeCount();
      this.buffer.cursor.line += step;
      this.buffer.clampCursor(false);
      return true;
    }
    if (ev.name === 'home' || ev.char === '0') {
      this.countPrefix = '';
      this.buffer.cursor.col = 0;
      return true;
    }
    if (ev.char === '^') {
      this.countPrefix = '';
      this.buffer.cursor.col = this.buffer.firstNonWhitespaceCol();
      return true;
    }
    if (ev.name === 'end' || ev.char === '$') {
      this.countPrefix = '';
      this.buffer.cursor.col = Math.max(0, this.buffer.currentLine().length - 1);
      return true;
    }
    if (ev.char === 'G') {
      const target = this.countPrefix ? Math.max(0, this.consumeCount() - 1) : this.buffer.lines.length - 1;
      this.buffer.cursor.line = Math.min(target, this.buffer.lines.length - 1);
      this.buffer.cursor.col = this.buffer.firstNonWhitespaceCol();
      return true;
    }
    if (ev.char === 'w') {
      const count = this.consumeCount();
      for (let i = 0; i < count; i++) this.buffer.moveWordForward();
      return true;
    }
    if (ev.char === 'b') {
      const count = this.consumeCount();
      for (let i = 0; i < count; i++) this.buffer.moveWordBackward();
      return true;
    }
    if (ev.char === 'e') {
      const count = this.consumeCount();
      for (let i = 0; i < count; i++) this.buffer.moveWordEnd();
      return true;
    }
    if (ev.name === 'pageup') {
      this.buffer.cursor.line = Math.max(0, this.buffer.cursor.line - Math.max(4, pageSize - 2));
      this.buffer.clampCursor(false);
      return true;
    }
    if (ev.name === 'pagedown') {
      this.buffer.cursor.line += Math.max(4, pageSize - 2);
      this.buffer.clampCursor(false);
      return true;
    }
    return false;
  }

  private handleInsertKey(ev: KeyEvent): VimEngineAction {
    if (ev.name === 'escape') {
      this.mode = 'normal';
      if (this.buffer.cursor.col > 0) this.buffer.cursor.col -= 1;
      this.buffer.clampCursor(false);
      return { type: 'none' };
    }
    if (ev.name === 'left') {
      this.buffer.cursor.col = Math.max(0, this.buffer.cursor.col - 1);
      return { type: 'none' };
    }
    if (ev.name === 'right') {
      this.buffer.cursor.col = Math.min(this.buffer.currentLine().length, this.buffer.cursor.col + 1);
      return { type: 'none' };
    }
    if (ev.name === 'up') {
      this.buffer.cursor.line = Math.max(0, this.buffer.cursor.line - 1);
      this.buffer.clampCursor(true);
      return { type: 'none' };
    }
    if (ev.name === 'down') {
      this.buffer.cursor.line = Math.min(this.buffer.lines.length - 1, this.buffer.cursor.line + 1);
      this.buffer.clampCursor(true);
      return { type: 'none' };
    }
    if (ev.name === 'home') {
      this.buffer.cursor.col = 0;
      return { type: 'none' };
    }
    if (ev.name === 'end') {
      this.buffer.cursor.col = this.buffer.currentLine().length;
      return { type: 'none' };
    }

    if (!this.insertSnapshotTaken) {
      this.buffer.pushUndo();
      this.insertSnapshotTaken = true;
    }

    if (ev.name === 'enter') {
      this.buffer.insertNewline();
    } else if (ev.name === 'backspace') {
      this.buffer.backspace();
    } else if (ev.name === 'delete') {
      this.buffer.deleteCharAt(true);
    } else if (ev.name === 'tab') {
      this.buffer.insertText('  ');
    } else if (ev.char) {
      this.buffer.insertText(ev.char);
    }
    return { type: 'none' };
  }

  private handleVisualKey(ev: KeyEvent, pageSize: number): VimEngineAction {
    if (ev.name === 'escape' || (ev.char === 'v' && this.mode === 'visual') || (ev.char === 'V' && this.mode === 'visual-line')) {
      this.mode = 'normal';
      this.visualAnchor = null;
      return { type: 'none' };
    }
    if (ev.char === 'v') {
      this.mode = 'visual';
      return { type: 'none' };
    }
    if (ev.char === 'V') {
      this.mode = 'visual-line';
      return { type: 'none' };
    }
    if (this.tryHandleMotion(ev, pageSize)) {
      return { type: 'none' };
    }

    const anchor = this.visualAnchor;
    if (!anchor) return { type: 'none' };

    if (ev.char === 'y') {
      if (this.mode === 'visual-line') {
        const start = Math.min(anchor.line, this.buffer.cursor.line);
        const count = Math.abs(anchor.line - this.buffer.cursor.line) + 1;
        this.buffer.yankLines(start, count);
        this.mode = 'normal';
        this.visualAnchor = null;
        return { type: 'none', message: `${count} linha(s) copiada(s)` };
      }
      this.buffer.yankCharRange(anchor, this.buffer.cursor);
      this.mode = 'normal';
      this.visualAnchor = null;
      return { type: 'none', message: 'Seleção copiada para o register' };
    }

    if (ev.char === 'd' || ev.char === 'x' || ev.char === 'c') {
      const enterInsert = ev.char === 'c';
      if (this.mode === 'visual-line') {
        const start = Math.min(anchor.line, this.buffer.cursor.line);
        const count = Math.abs(anchor.line - this.buffer.cursor.line) + 1;
        this.buffer.deleteLines(start, count);
      } else {
        this.buffer.deleteCharRange(anchor, this.buffer.cursor);
      }
      this.visualAnchor = null;
      if (enterInsert) {
        this.enterInsertMode(false);
      } else {
        this.mode = 'normal';
      }
      return { type: 'none', message: enterInsert ? undefined : 'Seleção removida' };
    }

    return { type: 'none' };
  }

  private handleCommandKey(ev: KeyEvent): VimEngineAction {
    if (ev.name === 'escape') {
      this.mode = 'normal';
      this.commandInput = '';
      return { type: 'none' };
    }
    if (ev.name === 'backspace') {
      this.commandInput = this.commandInput.slice(0, -1);
      if (this.commandInput.length === 0) this.mode = 'normal';
      return { type: 'none' };
    }
    if (ev.name === 'enter') {
      const cmd = this.commandInput.trim();
      this.mode = 'normal';
      this.commandInput = '';
      return this.executeCommand(cmd);
    }
    if (ev.char) {
      this.commandInput += ev.char;
    }
    return { type: 'none' };
  }

  private executeCommand(cmd: string): VimEngineAction {
    if (!cmd) return { type: 'none' };
    if (cmd === 'w') return { type: 'save' };
    if (cmd === 'wq' || cmd === 'x') return { type: 'save-and-quit' };
    if (cmd === 'q!') return { type: 'force-quit' };
    if (cmd === 'q') {
      if (this.buffer.dirty) {
        return {
          type: 'none',
          isError: true,
          message: 'Alterações não salvas — use :wq para salvar ou :q! para sair sem salvar',
        };
      }
      return { type: 'quit' };
    }
    if (cmd === 'set nu' || cmd === 'set number') {
      this.showLineNumbers = true;
      return { type: 'none', message: 'Números de linha ativados' };
    }
    if (cmd === 'set nonu' || cmd === 'set nonumber') {
      this.showLineNumbers = false;
      return { type: 'none', message: 'Números de linha ocultados' };
    }
    if (/^\d+$/.test(cmd)) {
      const lineNum = Math.max(1, Number.parseInt(cmd, 10));
      this.buffer.cursor.line = Math.min(lineNum - 1, this.buffer.lines.length - 1);
      this.buffer.cursor.col = this.buffer.firstNonWhitespaceCol();
      return { type: 'none', message: `Linha ${this.buffer.cursor.line + 1}` };
    }
    return { type: 'none', isError: true, message: `Comando desconhecido: :${cmd}` };
  }

  private handleSearchKey(ev: KeyEvent): VimEngineAction {
    if (ev.name === 'escape') {
      this.mode = 'normal';
      this.commandInput = '';
      return { type: 'none' };
    }
    if (ev.name === 'backspace') {
      this.commandInput = this.commandInput.slice(0, -1);
      return { type: 'none' };
    }
    if (ev.name === 'enter') {
      this.searchQuery = this.commandInput.trim();
      this.commandInput = '';
      this.mode = 'normal';
      this.searchMatches = this.buffer.findAllMatches(this.searchQuery);
      if (!this.searchQuery) return { type: 'none' };
      if (this.searchMatches.length === 0) {
        return { type: 'none', isError: true, message: `Padrão não encontrado: ${this.searchQuery}` };
      }
      return this.jumpSearchMatch(false, true);
    }
    if (ev.char) {
      this.commandInput += ev.char;
    }
    return { type: 'none' };
  }

  private jumpSearchMatch(reverse: boolean, includeCurrent = false): VimEngineAction {
    if (!this.searchQuery) return { type: 'none' };
    this.searchMatches = this.buffer.findAllMatches(this.searchQuery);
    if (this.searchMatches.length === 0) {
      return { type: 'none', isError: true, message: `Padrão não encontrado: ${this.searchQuery}` };
    }

    const cur = this.buffer.cursor;
    let targetIdx = -1;
    if (!reverse) {
      targetIdx = this.searchMatches.findIndex((m) =>
        includeCurrent ? comparePos(m, cur) >= 0 : comparePos(m, cur) > 0
      );
      if (targetIdx === -1) targetIdx = 0;
    } else {
      for (let i = this.searchMatches.length - 1; i >= 0; i--) {
        const m = this.searchMatches[i];
        if (m && comparePos(m, cur) < 0) {
          targetIdx = i;
          break;
        }
      }
      if (targetIdx === -1) targetIdx = this.searchMatches.length - 1;
    }

    const found = this.searchMatches[targetIdx];
    if (found) {
      this.buffer.cursor = { line: found.line, col: found.col };
      return {
        type: 'none',
        message: `/${this.searchQuery} [${targetIdx + 1}/${this.searchMatches.length}]`,
      };
    }
    return { type: 'none' };
  }
}

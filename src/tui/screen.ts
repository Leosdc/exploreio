/**
 * Double-Buffered ANSI Screen Manager (SPEC-001)
 * Renderiza linhas com diffing incremental (zero flicker) e restauração
 * garantida do terminal ao encerrar ou receber sinais do SO.
 */

import { fitAnsi, RESET } from './ansi.js';

export class ScreenBuffer {
  private prevLines: string[] = [];
  private active = false;
  private width = 80;
  private height = 24;

  constructor() {
    this.syncSize();
  }

  public getSize(): { width: number; height: number } {
    this.syncSize();
    return { width: this.width, height: this.height };
  }

  public syncSize(): void {
    this.width = Math.max(40, process.stdout.columns || 100);
    this.height = Math.max(12, process.stdout.rows || 30);
  }

  public enter(): void {
    if (this.active) return;
    this.active = true;
    this.prevLines = [];
    // Alternate screen buffer, hide cursor, enable SGR mouse wheel tracking
    process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[H');
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
  }

  public leave(): void {
    if (!this.active) return;
    this.active = false;
    try {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    } catch {
      // Ignora erro caso stdin já tenha fechado durante shutdown
    }
    // Disable mouse tracking, show cursor, leave alternate screen buffer
    process.stdout.write('\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[0m\x1b[?1049l');
  }

  public forceClear(): void {
    this.prevLines = [];
  }

  /**
   * Envia apenas as linhas modificadas desde o último frame em uma única escrita
   * (minimiza flicker em Windows Terminal, PowerShell e emuladores POSIX).
   */
  public render(lines: readonly string[]): void {
    if (!this.active) return;
    this.syncSize();

    let output = '';
    const total = this.height;

    for (let row = 0; row < total; row++) {
      const raw = lines[row] ?? '';
      const fitted = `${fitAnsi(raw, this.width)}${RESET}`;
      if (this.prevLines[row] !== fitted) {
        output += `\x1b[${row + 1};1H\x1b[2K${fitted}`;
        this.prevLines[row] = fitted;
      }
    }

    if (this.prevLines.length > total) {
      this.prevLines.length = total;
    }

    if (output.length > 0) {
      process.stdout.write(output);
    }
  }
}

/**
 * Cross-Platform Raw Terminal Key & SGR Mouse Decoder (SPEC-001)
 * Decodifica setas, PgUp/PgDn, Home/End, Enter, Tab, Esc, Backspace, Ctrl+C,
 * caracteres UTF-8 e roda do mouse SGR (Windows Terminal, PowerShell, POSIX).
 */

export interface KeyEvent {
  readonly name: string;
  readonly char?: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
}

const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

export function parseInputChunk(raw: string): KeyEvent[] {
  const events: KeyEvent[] = [];
  let i = 0;

  while (i < raw.length) {
    const slice = raw.slice(i);

    // SGR mouse wheel events
    const mouse = slice.match(SGR_MOUSE_RE);
    if (mouse) {
      const code = Number(mouse[1]);
      if (code === 64) events.push({ name: 'wheel_up' });
      else if (code === 65) events.push({ name: 'wheel_down' });
      i += mouse[0].length;
      continue;
    }

    // ANSI CSI / SS3 sequences
    if (slice.startsWith('\x1b[A') || slice.startsWith('\x1bOA')) {
      events.push({ name: 'up' });
      i += 3;
      continue;
    }
    if (slice.startsWith('\x1b[B') || slice.startsWith('\x1bOB')) {
      events.push({ name: 'down' });
      i += 3;
      continue;
    }
    if (slice.startsWith('\x1b[C') || slice.startsWith('\x1bOC')) {
      events.push({ name: 'right' });
      i += 3;
      continue;
    }
    if (slice.startsWith('\x1b[D') || slice.startsWith('\x1bOD')) {
      events.push({ name: 'left' });
      i += 3;
      continue;
    }
    if (slice.startsWith('\x1b[5~')) {
      events.push({ name: 'pageup' });
      i += 4;
      continue;
    }
    if (slice.startsWith('\x1b[6~')) {
      events.push({ name: 'pagedown' });
      i += 4;
      continue;
    }
    if (slice.startsWith('\x1b[H') || slice.startsWith('\x1b[1~') || slice.startsWith('\x1bOH')) {
      events.push({ name: 'home' });
      i += slice.startsWith('\x1b[1~') ? 4 : 3;
      continue;
    }
    if (slice.startsWith('\x1b[F') || slice.startsWith('\x1b[4~') || slice.startsWith('\x1bOF')) {
      events.push({ name: 'end' });
      i += slice.startsWith('\x1b[4~') ? 4 : 3;
      continue;
    }
    if (slice.startsWith('\x1b[3~')) {
      events.push({ name: 'delete' });
      i += 4;
      continue;
    }
    if (slice.startsWith('\x1b[Z')) {
      events.push({ name: 'tab', shift: true });
      i += 3;
      continue;
    }

    // Ignore unknown CSI escape sequence gracefully
    if (slice.startsWith('\x1b[')) {
      const m = slice.match(/^\x1b\[[0-9;?]*[ -/]*[@-~]/);
      i += m ? m[0].length : 2;
      continue;
    }

    const ch = raw[i] ?? '';
    const code = ch.charCodeAt(0);

    if (code === 3) {
      events.push({ name: 'c', ctrl: true });
      i++;
    } else if (code === 13 || code === 10) {
      events.push({ name: 'enter' });
      i++;
    } else if (code === 9) {
      events.push({ name: 'tab' });
      i++;
    } else if (code === 27) {
      events.push({ name: 'escape' });
      i++;
    } else if (code === 127 || code === 8) {
      events.push({ name: 'backspace' });
      i++;
    } else if (code === 32) {
      events.push({ name: 'space', char: ' ' });
      i++;
    } else if (code >= 32) {
      const cp = raw.codePointAt(i) ?? code;
      const fullChar = String.fromCodePoint(cp);
      events.push({ name: 'char', char: fullChar });
      i += fullChar.length;
    } else {
      i++;
    }
  }

  return events;
}

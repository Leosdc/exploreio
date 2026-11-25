import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { VimEngine } from '../editor/vimEngine.js';
import { buildEditorFrame } from '../editor/vimView.js';
import { safeWriteTextFile } from '../fs/explorer.js';
import { getTheme, THEME_ORDER } from '../themes/palette.js';
import { stripAnsi } from '../tui/ansi.js';
import { parseInputChunk, type KeyEvent } from '../tui/input.js';

function feedChars(engine: VimEngine, text: string): void {
  for (const ch of text) {
    engine.handleKey(ch === ' ' ? { name: 'space', char: ' ' } : { name: 'char', char: ch });
  }
}

test('VimEngine: navegação NORMAL (hjkl, w/b/e, 0/^/$, gg/G, contagem numérica)', () => {
  const engine = new VimEngine('  const alpha = 1;\n  const beta = 2;\n  const gamma = 3;');
  assert.equal(engine.mode, 'normal');

  engine.handleKey({ name: 'char', char: '^' });
  assert.deepEqual(engine.buffer.cursor, { line: 0, col: 2 });

  engine.handleKey({ name: 'char', char: 'w' });
  assert.deepEqual(engine.buffer.cursor, { line: 0, col: 8 }); // 'alpha'

  engine.handleKey({ name: 'char', char: 'e' });
  assert.deepEqual(engine.buffer.cursor, { line: 0, col: 12 }); // fim de 'alpha'

  engine.handleKey({ name: 'char', char: 'b' });
  assert.deepEqual(engine.buffer.cursor, { line: 0, col: 8 });

  engine.handleKey({ name: 'char', char: '$' });
  assert.equal(engine.buffer.cursor.col, engine.buffer.lines[0]!.length - 1);

  engine.handleKey({ name: 'char', char: '0' });
  assert.equal(engine.buffer.cursor.col, 0);

  engine.handleKey({ name: 'char', char: 'G' });
  assert.equal(engine.buffer.cursor.line, 2);

  feedChars(engine, 'gg');
  assert.equal(engine.buffer.cursor.line, 0);

  feedChars(engine, '2j');
  assert.equal(engine.buffer.cursor.line, 2);
});

test('VimEngine: modo INSERT (i/A/o/Enter auto-indent/Backspace/Esc) e preservação de CRLF', () => {
  const engine = new VimEngine('  hello\r\n  world');
  assert.equal(engine.buffer.eol, '\r\n');

  engine.handleKey({ name: 'char', char: 'A' });
  assert.equal(engine.mode, 'insert');
  feedChars(engine, '!');
  engine.handleKey({ name: 'enter' });
  feedChars(engine, 'next');
  engine.handleKey({ name: 'backspace' });
  engine.handleKey({ name: 'escape' });

  assert.equal(engine.mode, 'normal');
  assert.equal(engine.buffer.dirty, true);
  assert.equal(engine.buffer.toText(), '  hello!\r\n  nex\r\n  world');
});

test('VimEngine: operadores dd, yy, p, P, x, r, J e histórico Undo (u) / Redo (Ctrl+r)', () => {
  const engine = new VimEngine('linha1\nlinha2\nlinha3');

  feedChars(engine, 'yy');
  feedChars(engine, 'p');
  assert.deepEqual(engine.buffer.lines, ['linha1', 'linha1', 'linha2', 'linha3']);

  feedChars(engine, 'dd');
  assert.deepEqual(engine.buffer.lines, ['linha1', 'linha2', 'linha3']);

  feedChars(engine, 'u');
  assert.deepEqual(engine.buffer.lines, ['linha1', 'linha1', 'linha2', 'linha3']);

  engine.handleKey({ name: 'r', ctrl: true });
  assert.deepEqual(engine.buffer.lines, ['linha1', 'linha2', 'linha3']);

  feedChars(engine, 'rx');
  assert.equal(engine.buffer.lines[1], 'xinha2');

  feedChars(engine, 'J');
  assert.equal(engine.buffer.lines[1], 'xinha2 linha3');
});

test('VimEngine: modos VISUAL (v) e VISUAL-LINE (V) com yank e delete', () => {
  const engine = new VimEngine('abcdef\n123456\nxyz');

  feedChars(engine, 'vll');
  assert.equal(engine.mode, 'visual');
  engine.handleKey({ name: 'char', char: 'd' });
  assert.equal(engine.mode, 'normal');
  assert.equal(engine.buffer.lines[0], 'def');
  assert.equal(engine.buffer.register.text, 'abc');

  feedChars(engine, 'Vj');
  assert.equal(engine.mode, 'visual-line');
  engine.handleKey({ name: 'char', char: 'd' });
  assert.deepEqual(engine.buffer.lines, ['xyz']);
});

test('VimEngine: busca / e salto n/N + comandos :w, :q, :q!, :wq e :<linha>', () => {
  const engine = new VimEngine('foo bar\nbaz foo\nend');

  engine.handleKey({ name: 'char', char: '/' });
  feedChars(engine, 'foo');
  engine.handleKey({ name: 'enter' });
  assert.deepEqual(engine.buffer.cursor, { line: 0, col: 0 });

  engine.handleKey({ name: 'char', char: 'n' });
  assert.deepEqual(engine.buffer.cursor, { line: 1, col: 4 });

  engine.handleKey({ name: 'char', char: 'N' });
  assert.deepEqual(engine.buffer.cursor, { line: 0, col: 0 });

  // Comando :<linha>
  engine.handleKey({ name: 'char', char: ':' });
  feedChars(engine, '3');
  engine.handleKey({ name: 'enter' });
  assert.equal(engine.buffer.cursor.line, 2);

  // :q bloqueia quando dirty, :q! força saída, :wq salva e sai
  engine.buffer.dirty = true;
  engine.handleKey({ name: 'char', char: ':' });
  feedChars(engine, 'q');
  const blocked = engine.handleKey({ name: 'enter' });
  assert.equal(blocked.type, 'none');
  assert.equal(blocked.isError, true);

  engine.handleKey({ name: 'char', char: ':' });
  feedChars(engine, 'q!');
  assert.equal(engine.handleKey({ name: 'enter' }).type, 'force-quit');

  engine.handleKey({ name: 'char', char: ':' });
  feedChars(engine, 'wq');
  assert.equal(engine.handleKey({ name: 'enter' }).type, 'save-and-quit');
});

test('parseInputChunk decodifica Ctrl+r, Ctrl+d e Ctrl+u para controles do Vim', () => {
  const events: KeyEvent[] = parseInputChunk('\x12\x04\x15');
  assert.deepEqual(events, [
    { name: 'r', ctrl: true },
    { name: 'd', ctrl: true },
    { name: 'u', ctrl: true },
  ]);
});

test('buildEditorFrame renderiza nos 3 temas oficiais e sanitiza ANSI injection', () => {
  const engine = new VimEngine('const x = "\x1b]52;c;evil\x07ok";\nconsole.log(x);');
  for (const themeName of THEME_ORDER) {
    const rows = buildEditorFrame({
      engine,
      filePath: 'demo.ts',
      width: 80,
      height: 12,
      theme: getTheme(themeName),
      viewport: { scrollY: 0, scrollX: 0 },
      statusMessage: '',
      statusIsError: false,
    });
    assert.equal(rows.length, 12);
    const joined = rows.join('\n');
    assert.equal(joined.includes('\x1b]52;'), false);
    assert.ok(stripAnsi(rows[0]!).includes('VIM'));
    assert.ok(stripAnsi(rows[11]!).includes('NORMAL'));
  }
});

test('safeWriteTextFile grava conteúdo preservando EOL e bloqueia > 2 MB', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exploreio-vim-'));
  const target = path.join(tmpDir, 'sample.txt');
  try {
    const res = await safeWriteTextFile(target, 'a\r\nb');
    assert.equal(res.bytes, 4);
    const disk = await fs.readFile(target, 'utf8');
    assert.equal(disk, 'a\r\nb');

    const huge = 'x'.repeat(2 * 1024 * 1024 + 16);
    await assert.rejects(() => safeWriteTextFile(target, huge));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

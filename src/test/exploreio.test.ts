import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { parseCliArgs } from '../cli.js';
import {
  detectMagicSignature,
  formatBytes,
  fuzzyMatch,
  isBufferBinary,
  readDirectoryEntries,
  safeReadFilePreview,
} from '../fs/explorer.js';
import { detectLanguageFromPath, renderCodeLines } from '../renderers/code.js';
import { decodeHtmlEntities, renderHtmlDocument } from '../renderers/html.js';
import { detectDocumentKind, renderDocument } from '../renderers/index.js';
import { collectAllCollapsiblePaths, renderJsonDocument } from '../renderers/json.js';
import { renderMarkdown } from '../renderers/markdown.js';
import { getTheme, nextTheme, THEMES } from '../themes/palette.js';
import { highlightSearch, stripAnsi, stripUnsafeAnsi, truncateAnsi, visibleLength } from '../tui/ansi.js';
import { copyTextToClipboard, formatOsc52Sequence, getClipboardCommands } from '../tui/clipboard.js';
import { parseInputChunk } from '../tui/input.js';

describe('Exploreio ANSI Safety & Text Primitives', () => {
  it('remove sequências ANSI/OSC maliciosas (anti-ANSI-injection)', () => {
    const malicious = '\x1b]52;c;ZGF0YQ==\x07Olá \x1b[31mMundo\x1b[0m\x00!';
    const cleaned = stripUnsafeAnsi(malicious);
    assert.equal(cleaned, 'Olá Mundo!');
    assert.ok(!cleaned.includes('\x1b'));
  });

  it('calcula largura visível e trunca preservando reset ANSI', () => {
    const styled = '\x1b[31mExploreio CLI\x1b[0m';
    assert.equal(visibleLength(styled), 13);
    const truncated = truncateAnsi(styled, 8);
    assert.equal(visibleLength(truncated), 8);
    assert.ok(truncated.endsWith('\x1b[0m'));
  });

  it('destaca ocorrências de busca case-insensitive', () => {
    const theme = getTheme('midnight');
    const res = highlightSearch('Hello Exploreio world exploreio', 'exploreio', theme.searchBg, theme.searchFg);
    assert.equal(res.matches, 2);
    assert.equal(stripAnsi(res.text), 'Hello Exploreio world exploreio');
  });
});

describe('Exploreio 3 Official Themes', () => {
  it('alterna ciclicamente entre midnight, parchment e nord', () => {
    assert.equal(Object.keys(THEMES).length, 3);
    assert.equal(nextTheme('midnight'), 'parchment');
    assert.equal(nextTheme('parchment'), 'nord');
    assert.equal(nextTheme('nord'), 'midnight');
  });
});

describe('Exploreio Native Renderers (Markdown, JSON, HTML, Code)', () => {
  const theme = getTheme('midnight');

  it('renderiza Markdown com título, checklist, callout, tabela Unicode e bloco de código', () => {
    const md = [
      '# Exploreio',
      '',
      '> [!TIP] Leitura direta no prompt!',
      '',
      '- [x] Markdown rico',
      '- [ ] Exportação',
      '',
      '| Formato | Modo |',
      '| --- | --- |',
      '| JSON | Tree |',
      '',
      '```ts',
      'const ok: boolean = true;',
      '```',
    ].join('\n');

    const lines = renderMarkdown(md, 80, theme, 'rendered');
    const plain = lines.map(stripAnsi).join('\n');
    assert.ok(plain.includes('Exploreio'));
    assert.ok(plain.includes('TIP'));
    assert.ok(plain.includes('☑'));
    assert.ok(plain.includes('☐'));
    assert.ok(plain.includes('┌') && plain.includes('└'));
    assert.ok(plain.includes('const ok: boolean = true;'));

    // Regressão: negrito e código inline que cruzam quebra de linha não devem vazar ** ou `
    const wrapped = renderMarkdown(
      'Texto introdutório com **negrito muito longo que cruza a quebra de linha** e `codigo inline longo`.',
      42,
      theme,
      'rendered'
    ).map(stripAnsi).join('\n');
    assert.ok(!wrapped.includes('**'), 'não deve vazar asteriscos de negrito após wrap');
    assert.ok(!wrapped.includes('`'), 'não deve vazar crases de código inline após wrap');
  });

  it('renderiza JSON em Tree View recolhível, Pretty Highlighted e diagnostica JSON inválido', () => {
    const sample = JSON.stringify({ app: 'exploreio', features: ['md', 'json'], nested: { ok: true } });
    const expanded = renderJsonDocument(sample, theme, 'tree', new Set());
    assert.equal(expanded.valid, true);
    assert.ok(expanded.treeRows.length >= 6);

    const collapsed = renderJsonDocument(sample, theme, 'tree', new Set(['$.features', '$.nested']));
    assert.ok(collapsed.treeRows.length < expanded.treeRows.length);
    assert.ok(collectAllCollapsiblePaths(JSON.parse(sample)).includes('$.nested'));

    const pretty = renderJsonDocument(sample, theme, 'pretty');
    assert.equal(pretty.valid, true);
    assert.ok(pretty.lines.some((l) => stripAnsi(l).includes('"app"')));

    const invalid = renderJsonDocument('{ "broken": ', theme, 'tree');
    assert.equal(invalid.valid, false);
    assert.ok(stripAnsi(invalid.lines[0] ?? '').includes('JSON inválido'));
  });

  it('renderiza HTML em modo Reader removendo <script>/<style> e preservando tabela/links', () => {
    const html = `<!doctype html><html><head><title>Demo &amp; Test</title><style>body{color:red}</style></head>
      <body><h1>Olá Mundo</h1><script>alert('xss')</script>
      <p>Veja <a href="https://example.com">docs</a>.</p>
      <table><tr><th>Col</th></tr><tr><td>Val</td></tr></table></body></html>`;

    assert.equal(decodeHtmlEntities('A &amp; B &lt;3&#33;'), 'A & B <3!');
    const readerLines = renderHtmlDocument(html, 80, theme, 'reader');
    const plain = readerLines.map(stripAnsi).join('\n');
    assert.ok(plain.includes('Demo & Test'));
    assert.ok(plain.includes('Olá Mundo'));
    assert.ok(plain.includes('docs [https://example.com]'));
    assert.ok(!plain.includes("alert('xss')"));
    assert.ok(!plain.includes('color:red'));

    const sourceLines = renderHtmlDocument(html, 80, theme, 'source');
    assert.ok(sourceLines.some((l) => stripAnsi(l).includes('<h1>Olá Mundo</h1>')));
  });

  it('destaca sintaxe de código com números de linha e detecta binários', () => {
    assert.equal(detectLanguageFromPath('app.ts'), 'ts');
    assert.equal(detectLanguageFromPath('main.py'), 'py');
    const codeLines = renderCodeLines('export function hi() { return 42; }', {
      language: 'ts',
      theme,
      showLineNumbers: true,
    });
    assert.equal(codeLines.length, 1);
    assert.ok(stripAnsi(codeLines[0] ?? '').includes('1 │ export function hi()'));

    const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    assert.equal(isBufferBinary(pngHeader), true);
    assert.equal(detectMagicSignature(pngHeader), 'PNG Image');
    assert.equal(detectDocumentKind('photo.png', true), 'binary');
  });
});

describe('Exploreio FS, Input Decoder & CLI Args', () => {
  it('lista diretório com filtro fuzzy e leitura segura de arquivo', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'exploreio-test-'));
    try {
      await fs.mkdir(path.join(tmp, 'subpasta'));
      await fs.writeFile(path.join(tmp, 'nota.md'), '# Nota\nConteúdo', 'utf8');
      await fs.writeFile(path.join(tmp, '.oculto'), 'secret', 'utf8');

      const visible = await readDirectoryEntries(tmp, { showHidden: false });
      assert.equal(visible.entries.length, 2);
      assert.equal(visible.entries[0]?.name, 'subpasta');
      assert.equal(visible.entries[1]?.name, 'nota.md');

      const withHidden = await readDirectoryEntries(tmp, { showHidden: true });
      assert.equal(withHidden.entries.length, 3);

      const filtered = await readDirectoryEntries(tmp, { showHidden: true, filter: 'ntm' });
      assert.equal(filtered.entries[0]?.name, 'nota.md');
      assert.equal(fuzzyMatch('core-explorer.SPEC.md', 'ceSpec'), true);
      assert.equal(formatBytes(1536), '1.5 KB');

      const preview = await safeReadFilePreview(path.join(tmp, 'nota.md'));
      const doc = renderDocument(preview, { width: 80, theme: getTheme('nord') });
      assert.equal(doc.kind, 'markdown');
      assert.equal(doc.activeMode, 'rendered');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('decodifica teclas especiais, mouse SGR e argumentos CLI', () => {
    const events = parseInputChunk('\x1b[A\x1b[B\x1b[<65;10;5M\x03\r');
    assert.deepEqual(
      events.map((e) => e.name),
      ['up', 'down', 'wheel_down', 'c', 'enter']
    );
    assert.equal(events[3]?.ctrl, true);

    const parsed = parseCliArgs(['-p', 'README.md', '-m', 'raw', '-t', 'nord', '-w', '100']);
    assert.equal(parsed.printMode, true);
    assert.equal(parsed.target, 'README.md');
    assert.equal(parsed.viewMode, 'raw');
    assert.equal(parsed.theme, 'nord');
    assert.equal(parsed.width, 100);
  });

  it('copia caminhos com fallback multiplataforma seguro e OSC 52', async () => {
    assert.equal(getClipboardCommands('win32')[0]?.command, 'powershell.exe');
    assert.equal(getClipboardCommands('darwin')[0]?.command, 'pbcopy');
    assert.equal(getClipboardCommands('linux')[0]?.command, 'wl-copy');

    const osc = formatOsc52Sequence('C:\\Dev\\exploreio\\README.md');
    assert.ok(osc.startsWith('\x1b]52;c;'));
    assert.ok(osc.endsWith('\x07'));

    const emptyRes = await copyTextToClipboard('');
    assert.equal(emptyRes.ok, false);

    // Fallback de comando nativo (primeiro falha, segundo sucede)
    const tried: string[] = [];
    const nativeRes = await copyTextToClipboard('C:\\Dev\\exploreio\\pasta com ação', {
      platform: 'win32',
      allowOsc52Fallback: false,
      runner: async (cmd, text) => {
        tried.push(`${cmd.command}:${text}`);
        if (cmd.command === 'powershell.exe') throw new Error('indisponível');
      },
    });
    assert.equal(nativeRes.ok, true);
    assert.equal(nativeRes.method, 'clip');
    assert.equal(tried.length, 2);

    // Fallback OSC 52 quando todos comandos nativos falham
    let capturedOsc = '';
    const oscRes = await copyTextToClipboard('/home/dev/projeto', {
      platform: 'linux',
      allowOsc52Fallback: true,
      writeOsc52: (seq) => {
        capturedOsc = seq;
      },
      runner: async () => {
        throw new Error('sem utilitário');
      },
    });
    assert.equal(oscRes.ok, true);
    assert.equal(oscRes.method, 'osc52');
    assert.equal(capturedOsc, formatOsc52Sequence('/home/dev/projeto'));
  });
});

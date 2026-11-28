import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getHelpText, parseCliArgs } from '../cli.js';
import {
  DEFAULT_KEYBIND_DEFINITIONS,
  KeybindRegistry,
  formatKeyEvent,
  formatKeyForDisplay,
  initBaseConfigFile,
  loadKeybindsRegistry,
  normalizeKeySpec,
  saveKeybindsConfig,
} from '../config/keybinds.js';
import { getTheme } from '../themes/palette.js';
import { visibleLength } from '../tui/ansi.js';
import { parseInputChunk } from '../tui/input.js';
import { buildKeybindsPanelFrame, getFilteredKeybindDefinitions } from '../tui/keybindsView.js';

function makeTempConfigPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exploreio-binds-'));
  return path.join(dir, name);
}

test('normalizeKeySpec e formatKeyEvent normalizam teclas, preservam case e bloqueiam ANSI', () => {
  assert.equal(normalizeKeySpec('Ctrl+G'), 'ctrl+g');
  assert.equal(normalizeKeySpec('Shift+Tab'), 'shift+tab');
  assert.equal(normalizeKeySpec('Esc'), 'escape');
  assert.equal(normalizeKeySpec('Bksp'), 'backspace');
  assert.equal(normalizeKeySpec('PgUp'), 'pageup');
  assert.equal(normalizeKeySpec(' '), 'space');
  assert.equal(normalizeKeySpec('j'), 'j');
  assert.equal(normalizeKeySpec('J'), 'J');
  assert.equal(normalizeKeySpec('\x1b]52;c;evil\x07'), null);
  assert.equal(normalizeKeySpec(''), null);

  assert.equal(formatKeyEvent(parseInputChunk('\x07')[0]!), 'ctrl+g');
  assert.equal(formatKeyEvent(parseInputChunk('\x1b[Z')[0]!), 'shift+tab');
  assert.equal(formatKeyEvent(parseInputChunk('K')[0]!), 'K');
  assert.equal(formatKeyEvent(parseInputChunk('k')[0]!), 'k');
  assert.equal(formatKeyEvent({ name: 'wheel_up' }), null);

  assert.equal(formatKeyForDisplay('ctrl+k'), 'Ctrl+K');
  assert.equal(formatKeyForDisplay('up'), '↑');
  assert.equal(formatKeyForDisplay('shift+tab'), 'Shift+Tab');
});

test('KeybindRegistry aplica overrides, diferencia case e detecta conflitos', () => {
  const registry = new KeybindRegistry({
    browser: {
      moveDown: ['ctrl+n', 'j'],
      moveUp: ['ctrl+p', 'k'],
    },
  });

  assert.equal(registry.isModified('browser.moveDown'), true);
  assert.equal(registry.isModified('browser.open'), false);
  assert.equal(registry.matches('browser.moveDown', { name: 'n', ctrl: true }), true);
  assert.equal(registry.matches('browser.moveDown', { name: 'char', char: 'j' }), true);
  assert.equal(registry.matches('browser.moveDown', { name: 'char', char: 'J' }), false);

  // Sem conflitos reais nos padrões
  assert.equal(registry.findConflicts().length, 0);

  // Criar conflito proposital no contexto browser
  registry.replacePrimaryKey('browser.deleteEntry', 'j');
  const conflicts = registry.getConflictsForAction('browser.deleteEntry');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.key, 'j');
  assert.ok(conflicts[0]?.actions.includes('browser.moveDown'));

  // Adicionar, remover e resetar
  assert.equal(registry.addKey('browser.deleteEntry', 'x'), true);
  assert.deepEqual(registry.getKeys('browser.deleteEntry'), ['j', 'x']);
  assert.equal(registry.removeLastKey('browser.deleteEntry'), true);
  assert.deepEqual(registry.getKeys('browser.deleteEntry'), ['j']);
  assert.equal(registry.removeLastKey('browser.deleteEntry'), false); // mínimo 1 tecla

  registry.resetAction('browser.deleteEntry');
  assert.deepEqual(registry.getKeys('browser.deleteEntry'), ['d']);
});

test('Persistência fail-safe preserva theme, trata JSON inválido e bloqueia prototype pollution', () => {
  const cfgPath = makeTempConfigPath('.exploreiorc.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ theme: 'nord', customFlag: true }), 'utf8');

  const reg = new KeybindRegistry();
  reg.replacePrimaryKey('global.openKeybinds', 'ctrl+b');
  const saved = saveKeybindsConfig(reg, cfgPath);
  assert.equal(saved.ok, true);

  const reloadedRaw = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
  assert.equal(reloadedRaw.theme, 'nord');
  assert.equal(reloadedRaw.customFlag, true);

  const loaded = loadKeybindsRegistry(cfgPath);
  assert.equal(loaded.loadedFromFile, true);
  assert.equal(loaded.warning, undefined);
  assert.deepEqual(loaded.registry.getKeys('global.openKeybinds'), ['ctrl+b', 'ctrl+k']);

  // JSON corrompido -> fallback seguro sem crash
  const brokenPath = makeTempConfigPath('broken.json');
  fs.writeFileSync(brokenPath, '{invalid json', 'utf8');
  const brokenLoaded = loadKeybindsRegistry(brokenPath);
  assert.equal(brokenLoaded.loadedFromFile, false);
  assert.ok(brokenLoaded.warning);
  assert.deepEqual(brokenLoaded.registry.getKeys('global.quit'), ['q']);

  // Prototype pollution ignorado
  const protoPath = makeTempConfigPath('proto.json');
  fs.writeFileSync(
    protoPath,
    '{"keybinds":{"__proto__":{"polluted":["x"]},"browser":{"__proto__":["x"],"open":["enter"]}}}',
    'utf8'
  );
  const protoLoaded = loadKeybindsRegistry(protoPath);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.deepEqual(protoLoaded.registry.getKeys('browser.open'), ['enter']);
});

test('initBaseConfigFile cria arquivo base completo e exploreiorc.example.json é válido', () => {
  const cfgPath = makeTempConfigPath('init-rc.json');
  const created = initBaseConfigFile(cfgPath, { theme: 'parchment' });
  assert.equal(created.ok, true);
  assert.equal(created.created, true);

  const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as {
    theme?: string;
    keybinds?: Record<string, Record<string, string[]>>;
  };
  assert.equal(parsed.theme, 'parchment');
  assert.ok(parsed.keybinds?.global?.openKeybinds);
  assert.ok(parsed.keybinds?.browser?.openGitPanel);

  // Arquivo base versionado na raiz do repositório
  const examplePath = path.resolve(process.cwd(), 'exploreiorc.example.json');
  assert.equal(fs.existsSync(examplePath), true);
  const exampleLoaded = loadKeybindsRegistry(examplePath);
  assert.equal(exampleLoaded.warning, undefined);
  assert.equal(exampleLoaded.registry.findConflicts().length, 0);
});

test('buildKeybindsPanelFrame renderiza nos 3 temas oficiais, 1 e 2 painéis, com filtro e captura', () => {
  const registry = new KeybindRegistry();
  registry.replacePrimaryKey('browser.open', 'o');

  const filtered = getFilteredKeybindDefinitions(registry, 'browser', 'git');
  assert.equal(filtered.some((d) => d.id === 'browser.openGitPanel'), true);

  for (const themeName of ['midnight', 'parchment', 'nord'] as const) {
    const frame = buildKeybindsPanelFrame({
      width: 110,
      height: 28,
      theme: getTheme(themeName),
      registry,
      configPath: '~/.exploreiorc.json',
      footerLine: ' footer',
      state: {
        activeTab: 'all',
        selectedIndex: 0,
        scrollOffset: 0,
        filterQuery: '',
        captureMode: 'replace',
        dirty: true,
        statusMessage: '',
      },
    });
    assert.equal(frame.length, 28);
    assert.ok(frame.some((line) => line.includes('CAPTURANDO TECLA')));
    assert.ok(visibleLength(frame[0]!) <= 110);
  }

  // Layout compacto (1 painel)
  const narrow = buildKeybindsPanelFrame({
    width: 72,
    height: 18,
    theme: getTheme('midnight'),
    registry,
    configPath: '~/.exploreiorc.json',
    footerLine: ' footer',
    state: {
      activeTab: 'global',
      selectedIndex: 0,
      scrollOffset: 0,
      filterQuery: '',
      captureMode: null,
      dirty: false,
      statusMessage: '',
    },
  });
  assert.equal(narrow.length, 18);
  assert.equal(DEFAULT_KEYBIND_DEFINITIONS.length > 40, true);
});

test('CLI parseCliArgs suporta --init-config/--force/--config e getHelpText reflete binds customizados', () => {
  const parsed = parseCliArgs(['--init-config', '--force', '--config', './custom.json', '-t', 'nord']);
  assert.equal(parsed.initConfig, true);
  assert.equal(parsed.forceConfig, true);
  assert.equal(parsed.configPath, './custom.json');
  assert.equal(parsed.theme, 'nord');

  const customRegistry = new KeybindRegistry({
    global: {
      openKeybinds: ['ctrl+b'],
    },
  });
  const help = getHelpText(getTheme('midnight'), customRegistry);
  assert.ok(help.includes('Ctrl+B'));
  assert.ok(help.includes('--init-config'));
  assert.ok(help.includes('~/.exploreiorc.json'));
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getHelpText } from '../cli.js';
import { KeybindRegistry, loadKeybindsRegistry } from '../config/keybinds.js';
import {
  createFileSafe,
  createFolderSafe,
  duplicateEntrySafe,
  suggestDuplicateName,
  validateEntryPathCrossPlatform,
} from '../fs/explorer.js';
import { getTheme } from '../themes/palette.js';
import { visibleLength } from '../tui/ansi.js';
import {
  FILE_EXTENSION_PRESETS,
  applyModalOverlay,
  createInitialModalState,
  cycleModalExtension,
  hasManualExtension,
  renderCreateEntryModalOverlay,
  resolveModalTargetName,
} from '../tui/createEntryModal.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'exploreio-create-'));
}

test('validateEntryPathCrossPlatform valida regras cross-OS (Windows, macOS e Linux)', () => {
  const base = path.resolve(os.tmpdir(), 'exploreio-sandbox');

  // Caminhos válidos relativos com / e \
  const okLinux = validateEntryPathCrossPlatform(base, 'src/utils/helper.ts', 'linux');
  assert.equal(okLinux.ok, true);
  assert.equal(okLinux.topLevelSegment, 'src');

  const okWin = validateEntryPathCrossPlatform(base, 'src\\components\\Button.tsx', 'win32');
  assert.equal(okWin.ok, true);
  assert.equal(okWin.topLevelSegment, 'src');

  // Path traversal & absolutos bloqueados em qualquer SO
  for (const plat of ['win32', 'darwin', 'linux'] as const) {
    assert.equal(validateEntryPathCrossPlatform(base, '../escape.txt', plat).ok, false);
    assert.equal(validateEntryPathCrossPlatform(base, 'a/../../escape.txt', plat).ok, false);
    assert.equal(validateEntryPathCrossPlatform(base, '/etc/passwd', plat).ok, false);
    assert.equal(validateEntryPathCrossPlatform(base, 'C:\\Windows\\System32', plat).ok, false);
    assert.equal(validateEntryPathCrossPlatform(base, 'bad\x00name.txt', plat).ok, false);
    assert.equal(validateEntryPathCrossPlatform(base, 'a'.repeat(256), plat).ok, false);
  }

  // Trailing slash bloqueado para arquivo e aceito para pasta
  assert.equal(validateEntryPathCrossPlatform(base, 'folder/', 'linux', { allowTrailingSlash: false }).ok, false);
  assert.equal(validateEntryPathCrossPlatform(base, 'folder/', 'linux', { allowTrailingSlash: true }).ok, true);

  // Regras específicas de Windows
  assert.equal(validateEntryPathCrossPlatform(base, 'CON', 'win32').ok, false);
  assert.equal(validateEntryPathCrossPlatform(base, 'nul.txt', 'win32').ok, false);
  assert.equal(validateEntryPathCrossPlatform(base, 'COM1.log', 'win32').ok, false);
  assert.equal(validateEntryPathCrossPlatform(base, 'bad:name.ts', 'win32').ok, false);
  assert.equal(validateEntryPathCrossPlatform(base, 'bad*name.ts', 'win32').ok, false);
  assert.equal(validateEntryPathCrossPlatform(base, 'trailing.', 'win32').ok, false);
  assert.equal(validateEntryPathCrossPlatform(base, 'dir /file.ts', 'win32').ok, false);

  // Em Linux/macOS, dois pontos no nome é permitido pelo FS POSIX
  assert.equal(validateEntryPathCrossPlatform(base, '2026-11-28T12:00.log', 'linux').ok, true);
});

test('createFileSafe, createFolderSafe e duplicateEntrySafe criam com segurança e impedem sobrescrita', async () => {
  const dir = await makeTempDir();
  try {
    // Criar arquivo aninhado
    const f1 = await createFileSafe(dir, 'nested/app.ts');
    assert.equal(f1.focusName, 'nested');
    const st1 = await fs.stat(f1.targetPath);
    assert.equal(st1.isFile(), true);

    // Impedir sobrescrita de arquivo existente
    await assert.rejects(() => createFileSafe(dir, 'nested/app.ts'), /Já existe/);

    // Criar pasta aninhada
    const d1 = await createFolderSafe(dir, 'modules/auth/dto/');
    assert.equal(d1.focusName, 'modules');
    const st2 = await fs.stat(d1.targetPath);
    assert.equal(st2.isDirectory(), true);

    // Impedir recriação silenciosa de pasta existente
    await assert.rejects(() => createFolderSafe(dir, 'modules/auth/dto'), /Já existe/);

    // Duplicação de arquivo com conteúdo preservado
    await fs.writeFile(f1.targetPath, 'export const ok = true;\n', 'utf8');
    const dupFile = await duplicateEntrySafe(f1.targetPath, 'app-copy.ts');
    assert.equal(dupFile.focusName, 'app-copy.ts');
    assert.equal(await fs.readFile(dupFile.targetPath, 'utf8'), 'export const ok = true;\n');
    await assert.rejects(() => duplicateEntrySafe(f1.targetPath, 'app-copy.ts'), /Já existe/);

    // Duplicação recursiva de pasta
    const dupDir = await duplicateEntrySafe(path.join(dir, 'nested'), 'nested-copy');
    assert.equal(dupDir.focusName, 'nested-copy');
    assert.equal(await fs.readFile(path.join(dupDir.targetPath, 'app.ts'), 'utf8'), 'export const ok = true;\n');

    // Bloqueia duplicar pasta dentro de si mesma
    await assert.rejects(() => duplicateEntrySafe(path.join(dir, 'nested'), 'nested/sub'), /sobre si mesmo/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('suggestDuplicateName gera sufixos incrementais sem colisão para arquivos, dotfiles e pastas', () => {
  const existing = new Set(['report.md', 'report-copy.md', '.env', 'src']);
  assert.equal(suggestDuplicateName(existing, 'report.md', false), 'report-copy-2.md');
  assert.equal(suggestDuplicateName(existing, '.env', false), '.env-copy');
  assert.equal(suggestDuplicateName(existing, 'src', true), 'src-copy');
});

test('Modal de criação resolve extensões preset vs manual, dotfiles e renderiza nos 3 temas com anti-ANSI', () => {
  const state = createInitialModalState('file');
  assert.equal(FILE_EXTENSION_PRESETS[0], '');

  // Modo livre
  state.input = '.gitignore';
  assert.equal(hasManualExtension(state.input), false);
  assert.equal(resolveModalTargetName(state), '.gitignore');

  // Selecionando preset .ts (índice 1)
  cycleModalExtension(state, 1);
  state.input = 'service';
  assert.equal(resolveModalTargetName(state), 'service.ts');

  // Subpasta + preset
  state.input = 'src/api/client';
  assert.equal(resolveModalTargetName(state), 'src/api/client.ts');

  // Extensão manual explícita não é duplicada pelo preset
  state.input = 'Component.vue';
  assert.equal(hasManualExtension(state.input), true);
  assert.equal(resolveModalTargetName(state), 'Component.vue');

  // Wrap-around reverso no seletor
  cycleModalExtension(state, -2);
  assert.equal(state.extIndex, FILE_EXTENSION_PRESETS.length - 1);

  // Renderização nos 3 temas oficiais + sanitização anti-ANSI
  state.input = 'evil\x1b]52;c;payload\x07name';
  state.openInEditor = true;
  for (const themeName of ['midnight', 'parchment', 'nord'] as const) {
    const overlay = renderCreateEntryModalOverlay(state, '/tmp/project', 100, 30, getTheme(themeName), 'linux');
    assert.ok(overlay.length >= 10);
    assert.equal(overlay.some((l) => l.includes('\x1b]52')), false);
    assert.ok(overlay.every((l) => visibleLength(l) <= 100));

    const frame = Array.from({ length: 30 }, () => ' '.repeat(100));
    applyModalOverlay(frame, overlay, 30);
    assert.ok(frame.some((l) => l.includes('NOVO ARQUIVO')));
  }

  // Modo pasta
  const folderState = createInitialModalState('folder');
  folderState.input = 'src/modules/billing';
  const folderOverlay = renderCreateEntryModalOverlay(folderState, '/tmp/project', 90, 24, getTheme('nord'), 'win32');
  assert.ok(folderOverlay.some((l) => l.includes('NOVA PASTA')));
});

test('Novos keybinds de criação/duplicação existem sem conflitos no registry, example config e --help', () => {
  const registry = new KeybindRegistry();
  assert.deepEqual(registry.getKeys('browser.createFile'), ['n']);
  assert.deepEqual(registry.getKeys('browser.createFolder'), ['N', 'm']);
  assert.deepEqual(registry.getKeys('browser.duplicateEntry'), ['c']);
  assert.equal(registry.findConflicts().length, 0);

  const exampleLoaded = loadKeybindsRegistry(path.resolve(process.cwd(), 'exploreiorc.example.json'));
  assert.equal(exampleLoaded.warning, undefined);
  assert.equal(exampleLoaded.registry.findConflicts().length, 0);

  const help = getHelpText(getTheme('midnight'), registry);
  assert.ok(help.includes('Novo arquivo'));
  assert.ok(help.includes('Nova pasta'));
});

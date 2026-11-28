/**
 * Create File / Folder Interactive Modal (SPEC-007)
 * Estado, resolução inteligente de extensões e renderização TUI do modal
 * interativo de criação de arquivos e pastas com conformidade aos 3 temas oficiais.
 */

import { validateEntryPathCrossPlatform } from '../fs/explorer.js';
import { bg, fg, type ThemePalette } from '../themes/palette.js';
import { BOLD, DIM, RESET, fitAnsi, stripUnsafeAnsi, truncateAnsi } from './ansi.js';

export type CreateModalMode = 'file' | 'folder';

export interface CreateEntryModalState {
  mode: CreateModalMode;
  input: string;
  extIndex: number;
  openInEditor: boolean;
  errorMessage: string;
}

export const FILE_EXTENSION_PRESETS: readonly string[] = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.md',
  '.html',
  '.css',
  '.py',
  '.sh',
  '.yml',
  '.toml',
  '.txt',
];

export function createInitialModalState(mode: CreateModalMode): CreateEntryModalState {
  return {
    mode,
    input: '',
    extIndex: 0,
    openInEditor: false,
    errorMessage: '',
  };
}

export function hasManualExtension(rawInput: string): boolean {
  const trimmed = rawInput.trim();
  if (!trimmed) return false;
  const normalized = trimmed.replace(/\\/g, '/');
  const lastSegment = normalized.split('/').pop() ?? '';
  const lastDot = lastSegment.lastIndexOf('.');
  return lastDot > 0 && lastDot < lastSegment.length - 1;
}

export function resolveModalTargetName(state: Readonly<CreateEntryModalState>): string {
  const trimmed = state.input.trim();
  if (!trimmed || state.mode === 'folder') return trimmed;

  const preset = FILE_EXTENSION_PRESETS[state.extIndex] ?? '';
  if (!preset || hasManualExtension(trimmed)) return trimmed;

  return `${trimmed}${preset}`;
}

export function cycleModalExtension(state: CreateEntryModalState, delta: number): void {
  const len = FILE_EXTENSION_PRESETS.length;
  state.extIndex = (state.extIndex + delta + len) % len;
  state.errorMessage = '';
}

function buildExtensionChipRows(
  state: Readonly<CreateEntryModalState>,
  innerW: number,
  theme: ThemePalette
): string[] {
  const manual = hasManualExtension(state.input);
  const rows: string[] = [];
  let currentLine = '  ';
  let currentLen = 2;

  for (let i = 0; i < FILE_EXTENSION_PRESETS.length; i++) {
    const ext = FILE_EXTENSION_PRESETS[i] ?? '';
    const label = ext === '' ? '(livre)' : ext;
    const isActive = i === state.extIndex;
    const chipPlain = `[${label}] `;
    if (currentLen + chipPlain.length > innerW - 1 && currentLen > 2) {
      rows.push(currentLine);
      currentLine = '  ';
      currentLen = 2;
    }

    const chipStyled = isActive
      ? `${bg(manual ? theme.headerBg : theme.selectionBg)}${fg(manual ? theme.muted : theme.selectionFg)}${BOLD}[${label}]${RESET}${bg(theme.statusBg)} `
      : `${fg(theme.muted)}[${label}] ${RESET}${bg(theme.statusBg)}`;

    currentLine += chipStyled;
    currentLen += chipPlain.length;
  }

  if (currentLen > 2) rows.push(currentLine);
  return rows;
}

function buildPreviewStatusLine(
  state: Readonly<CreateEntryModalState>,
  baseDir: string,
  innerW: number,
  theme: ThemePalette,
  platform: NodeJS.Platform
): string {
  if (state.errorMessage) {
    return `  ${fg(theme.danger)}${BOLD}✖ ${truncateAnsi(stripUnsafeAnsi(state.errorMessage), innerW - 6)}${RESET}`;
  }

  const resolvedName = resolveModalTargetName(state);
  if (!resolvedName) {
    const placeholder =
      state.mode === 'file'
        ? 'Digite o nome (ex.: utils/helper ou App.vue) e escolha a extensão'
        : 'Digite o nome da pasta (ex.: components ou src/modules/auth)';
    return `  ${fg(theme.muted)}${DIM}${truncateAnsi(placeholder, innerW - 4)}${RESET}`;
  }

  const validation = validateEntryPathCrossPlatform(baseDir, resolvedName, platform, {
    allowTrailingSlash: state.mode === 'folder',
  });
  if (!validation.ok) {
    return `  ${fg(theme.warning)}${BOLD}⚠ ${truncateAnsi(stripUnsafeAnsi(validation.error ?? 'Caminho inválido'), innerW - 6)}${RESET}`;
  }

  const safeRel = stripUnsafeAnsi(validation.normalizedRelative ?? resolvedName);
  const label = state.mode === 'file' ? 'Arquivo:' : 'Pasta:';
  return `  ${fg(theme.accentAlt)}${BOLD}${label}${RESET}${bg(theme.statusBg)} ${fg(theme.success)}${truncateAnsi(safeRel, innerW - label.length - 5)}${RESET}`;
}

export function renderCreateEntryModalOverlay(
  state: Readonly<CreateEntryModalState>,
  baseDir: string,
  width: number,
  height: number,
  theme: ThemePalette,
  platform: NodeJS.Platform = process.platform
): string[] {
  const boxW = Math.min(76, Math.max(40, width - 4));
  const innerW = Math.max(20, boxW - 2);
  const padLeft = ' '.repeat(Math.max(0, Math.floor((width - boxW) / 2)));
  const safeBase = truncateAnsi(stripUnsafeAnsi(baseDir), Math.max(12, innerW - 10));
  const safeInput = truncateAnsi(stripUnsafeAnsi(state.input), Math.max(10, innerW - 14));

  const title =
    state.mode === 'file'
      ? '  ◈ NOVO ARQUIVO (digite o nome ou extensão livre · Esc cancela)'
      : '  ◈ NOVA PASTA (aceita subpastas a/b/c cross-OS · Esc cancela)';

  const bodyItems: string[] = [
    `  ${fg(theme.muted)}Em: ${safeBase}${RESET}`,
    '',
    `  ${fg(theme.accent)}${BOLD}Nome:${RESET}${bg(theme.statusBg)} ${bg(theme.selectionBg)}${fg(theme.selectionFg)}${BOLD} ${safeInput}█ ${RESET}`,
    '',
  ];

  if (state.mode === 'file') {
    const manualHint = hasManualExtension(state.input)
      ? ` ${fg(theme.accentAlt)}(extensão manual detectada)${RESET}`
      : ` ${fg(theme.muted)}(Tab / Shift+Tab / ↑↓ para trocar)${RESET}`;
    bodyItems.push(`  ${fg(theme.text)}${BOLD}Extensão:${RESET}${bg(theme.statusBg)}${manualHint}`);
    bodyItems.push(...buildExtensionChipRows(state, innerW, theme));
    bodyItems.push('');
    const check = state.openInEditor ? `${fg(theme.success)}${BOLD}[x]${RESET}` : `${fg(theme.muted)}[ ]${RESET}`;
    bodyItems.push(
      `  ${check}${bg(theme.statusBg)} ${fg(theme.text)}Abrir no Editor Vim após criar${RESET}${bg(theme.statusBg)} ${fg(theme.muted)}(Ctrl+E)${RESET}`
    );
    bodyItems.push('');
  } else {
    bodyItems.push(`  ${fg(theme.muted)}Dica: separadores / e \\ são normalizados automaticamente para o SO.${RESET}`);
    bodyItems.push('');
  }

  bodyItems.push(buildPreviewStatusLine(state, baseDir, innerW, theme, platform));
  bodyItems.push('');

  const footerHint =
    state.mode === 'file'
      ? '  Enter Criar · Tab/↑↓ Extensão · Ctrl+E Editor · Esc Cancelar'
      : '  Enter Criar pasta · Esc Cancelar';
  bodyItems.push(`${fg(theme.muted)}${DIM}${footerHint}${RESET}`);

  const maxBodyRows = Math.max(4, height - 4);
  const clippedBody = bodyItems.slice(0, maxBodyRows);

  return [
    `${padLeft}${fg(theme.borderActive)}${BOLD}╭${'─'.repeat(innerW)}╮${RESET}`,
    `${padLeft}${fg(theme.borderActive)}${BOLD}│${bg(theme.headerBg)}${fg(theme.accent)}${fitAnsi(title, innerW)}${RESET}${fg(theme.borderActive)}${BOLD}│${RESET}`,
    ...clippedBody.map(
      (item) =>
        `${padLeft}${fg(theme.borderActive)}│${bg(theme.statusBg)}${fg(theme.text)}${fitAnsi(item, innerW)}${RESET}${fg(theme.borderActive)}│${RESET}`
    ),
    `${padLeft}${fg(theme.borderActive)}${BOLD}╰${'─'.repeat(innerW)}╯${RESET}`,
  ];
}

export function applyModalOverlay(frameLines: string[], modalLines: readonly string[], height: number): void {
  if (modalLines.length === 0) return;
  const startRow = Math.max(1, Math.floor((height - modalLines.length) / 2));
  modalLines.forEach((mLine, offset) => {
    const targetRow = startRow + offset;
    if (targetRow >= 0 && targetRow < frameLines.length) {
      frameLines[targetRow] = mLine;
    }
  });
}

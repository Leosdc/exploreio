/**
 * Exploreio Interactive Keybinds Editor View (SPEC-006)
 * Renderiza o painel TUI interativo de visualização e edição de keybinds
 * respeitando os 3 temas oficiais (midnight, parchment, nord).
 */

import {
  CONTEXT_LABELS,
  formatKeyForDisplay,
  type KeybindContext,
  type KeybindDefinition,
  type KeybindRegistry,
} from '../config/keybinds.js';
import { bg, fg, type ThemePalette } from '../themes/palette.js';
import { BOLD, DIM, ITALIC, RESET, fitAnsi, stripUnsafeAnsi, truncateAnsi, visibleLength } from './ansi.js';

export type KeybindsFilterTab = 'all' | KeybindContext;

export const KEYBINDS_TABS: readonly { id: KeybindsFilterTab; num: string; label: string }[] = [
  { id: 'all', num: '1', label: 'Todos' },
  { id: 'global', num: '2', label: 'Global' },
  { id: 'browser', num: '3', label: 'Navegador' },
  { id: 'reader', num: '4', label: 'Leitor' },
  { id: 'git', num: '5', label: 'Painel Git' },
];

export interface KeybindsViewState {
  readonly activeTab: KeybindsFilterTab;
  readonly selectedIndex: number;
  readonly scrollOffset: number;
  readonly filterQuery: string;
  readonly captureMode: null | 'replace' | 'add';
  readonly dirty: boolean;
  readonly statusMessage: string;
}

export interface KeybindsFrameOptions {
  readonly width: number;
  readonly height: number;
  readonly theme: ThemePalette;
  readonly registry: KeybindRegistry;
  readonly state: KeybindsViewState;
  readonly configPath: string;
  readonly footerLine: string;
}

export function getFilteredKeybindDefinitions(
  registry: KeybindRegistry,
  activeTab: KeybindsFilterTab,
  filterQuery: string
): readonly KeybindDefinition[] {
  const base = activeTab === 'all' ? registry.getDefinitions() : registry.getDefinitions(activeTab);
  const q = filterQuery.trim().toLowerCase();
  if (!q) return base;

  return base.filter((def) => {
    const keysStr = registry.formatActionKeys(def.id, ' ').toLowerCase();
    const rawKeysStr = registry.getKeys(def.id).join(' ').toLowerCase();
    return (
      def.id.toLowerCase().includes(q) ||
      def.label.toLowerCase().includes(q) ||
      def.description.toLowerCase().includes(q) ||
      CONTEXT_LABELS[def.context].toLowerCase().includes(q) ||
      keysStr.includes(q) ||
      rawKeysStr.includes(q)
    );
  });
}

function buildHeaderLine(opts: KeybindsFrameOptions): string {
  const { width, theme, state, configPath } = opts;
  const brand = `${bg(theme.headerBg)}${fg(theme.accent)}${BOLD} ◈ EXPLOREIO · KEYBINDS ${RESET}`;
  const stateBadge = state.dirty
    ? `${bg(theme.headerBg)}${fg(theme.warning)}${BOLD} ● não salvo ${RESET}`
    : `${bg(theme.headerBg)}${fg(theme.success)} ✓ salvo ${RESET}`;
  const safePath = stripUnsafeAnsi(configPath);
  const pathBudget = Math.max(10, width - visibleLength(brand) - visibleLength(stateBadge) - 4);
  const pathPill = `${bg(theme.headerBg)}${fg(theme.muted)} ${truncateAnsi(safePath, pathBudget)} ${RESET}`;
  const fillLen = Math.max(0, width - visibleLength(brand) - visibleLength(stateBadge) - visibleLength(pathPill));
  const fill = `${bg(theme.headerBg)}${' '.repeat(fillLen)}${RESET}`;
  return `${brand}${stateBadge}${fill}${pathPill}`;
}

function buildTabsLine(opts: KeybindsFrameOptions, totalItems: number, totalConflicts: number): string {
  const { width, theme, state } = opts;
  const parts = KEYBINDS_TABS.map((tab) => {
    const active = tab.id === state.activeTab;
    return active
      ? `${bg(theme.selectionBg)}${fg(theme.selectionFg)}${BOLD} ${tab.num}:${tab.label} ${RESET}`
      : `${fg(theme.muted)} ${tab.num}:${tab.label} ${RESET}`;
  });

  const filterTag = state.filterQuery
    ? ` ${fg(theme.accent)}[filtro: ${stripUnsafeAnsi(state.filterQuery)}]${RESET}`
    : '';
  const conflictTag =
    totalConflicts > 0
      ? ` ${fg(theme.warning)}${BOLD}⚠ ${totalConflicts} conflito(s)${RESET}`
      : ` ${fg(theme.muted)}(${totalItems} ações)${RESET}`;

  return fitAnsi(` ${parts.join(`${fg(theme.border)}·${RESET}`)}${filterTag}${conflictTag}`, width);
}

function buildDetailLines(
  selected: KeybindDefinition | undefined,
  registry: KeybindRegistry,
  state: KeybindsViewState,
  configPath: string,
  theme: ThemePalette,
  detailW: number
): string[] {
  const lines: string[] = [];
  if (!selected) {
    lines.push(`${fg(theme.muted)}${ITALIC} Nenhuma ação corresponde ao filtro.${RESET}`);
    return lines;
  }

  const keys = registry.getKeys(selected.id);
  const conflicts = registry.getConflictsForAction(selected.id);
  const modified = registry.isModified(selected.id);

  lines.push(`${fg(theme.accentAlt)}${BOLD} ${stripUnsafeAnsi(selected.label)}${RESET}`);
  lines.push(`${fg(theme.muted)} ID: ${fg(theme.text)}${selected.id}${RESET}`);
  lines.push(`${fg(theme.muted)} Contexto: ${fg(theme.accent)}${CONTEXT_LABELS[selected.context]}${RESET}`);
  lines.push('');
  lines.push(`${fg(theme.text)} ${truncateAnsi(stripUnsafeAnsi(selected.description), Math.max(12, detailW - 2))}${RESET}`);
  lines.push('');
  lines.push(
    `${fg(theme.muted)} Atalho(s) atual(is):${modified ? ` ${fg(theme.warning)}(customizado)${RESET}` : ''}`
  );
  lines.push(
    `  ${fg(theme.accent)}${BOLD}${keys.map(formatKeyForDisplay).join('  ·  ')}${RESET}`
  );
  lines.push(
    `${fg(theme.muted)} Padrão: ${selected.defaultKeys.map(formatKeyForDisplay).join(' · ')}${RESET}`
  );

  if (state.captureMode) {
    const modeLabel = state.captureMode === 'replace' ? 'SUBSTITUIR tecla principal' : 'ADICIONAR tecla alternativa';
    lines.push('');
    lines.push(`${bg(theme.selectionBg)}${fg(theme.selectionFg)}${BOLD} ◉ CAPTURANDO TECLA ${RESET}`);
    lines.push(`${fg(theme.warning)} ${modeLabel}${RESET}`);
    lines.push(`${fg(theme.muted)} Pressione qualquer tecla agora${RESET}`);
    lines.push(`${fg(theme.muted)} (Esc cancela · Ctrl+C sai)${RESET}`);
  }

  if (conflicts.length > 0) {
    lines.push('');
    lines.push(`${fg(theme.warning)}${BOLD} ⚠ Conflito detectado neste contexto:${RESET}`);
    for (const c of conflicts) {
      const others = c.actions.filter((a) => a !== selected.id).join(', ');
      lines.push(`${fg(theme.warning)}  [${formatKeyForDisplay(c.key)}] → ${others}${RESET}`);
    }
  }

  lines.push('');
  lines.push(`${fg(theme.accentAlt)}${BOLD} Comandos do Painel${RESET}`);
  lines.push(`${fg(theme.accent)} Enter${fg(theme.text)}  Capturar nova tecla principal${RESET}`);
  lines.push(`${fg(theme.accent)} + / a${fg(theme.text)}  Adicionar tecla alternativa${RESET}`);
  lines.push(`${fg(theme.accent)} d / ⌫${fg(theme.text)}  Remover última tecla${RESET}`);
  lines.push(`${fg(theme.accent)} r / R${fg(theme.text)}  Resetar ação / Resetar tudo${RESET}`);
  lines.push(`${fg(theme.accent)} s    ${fg(theme.text)}  Salvar em ~/.exploreiorc.json${RESET}`);
  lines.push(`${fg(theme.accent)} /    ${fg(theme.text)}  Filtrar ações por nome/tecla${RESET}`);
  lines.push(`${fg(theme.accent)} 1-5  ${fg(theme.text)}  Filtrar por contexto (Tab)${RESET}`);
  lines.push('');
  lines.push(`${fg(theme.muted)}${DIM} Config: ${truncateAnsi(stripUnsafeAnsi(configPath), Math.max(10, detailW - 10))}${RESET}`);

  return lines;
}

export function buildKeybindsPanelFrame(opts: KeybindsFrameOptions): string[] {
  const { width, height, theme, registry, state, configPath, footerLine } = opts;
  const items = getFilteredKeybindDefinitions(registry, state.activeTab, state.filterQuery);
  const allConflicts = registry.findConflicts();
  const bodyHeight = Math.max(4, height - 3);
  const useTwoPanes = width >= 90;
  const leftW = useTwoPanes ? Math.max(42, Math.floor(width * 0.6)) : width;
  const rightW = useTwoPanes ? Math.max(24, width - leftW - 1) : 0;
  const sep = `${fg(theme.border)}│${RESET}`;

  const rows: string[] = [
    buildHeaderLine(opts),
    buildTabsLine(opts, items.length, allConflicts.length),
  ];

  const selected = items[state.selectedIndex];
  const detailLines = useTwoPanes
    ? buildDetailLines(selected, registry, state, configPath, theme, rightW)
    : [];

  for (let r = 0; r < bodyHeight; r++) {
    const idx = state.scrollOffset + r;
    const def = items[idx];
    let leftStr = '';

    if (def) {
      const isSelected = idx === state.selectedIndex;
      const modified = registry.isModified(def.id);
      const hasConflict = registry.getConflictsForAction(def.id).length > 0;
      const ctxTag = state.activeTab === 'all' ? `[${CONTEXT_LABELS[def.context].slice(0, 4)}] ` : '';
      const marker = hasConflict ? '⚠' : modified ? '*' : ' ';
      const keysText = registry.formatActionKeys(def.id, ', ');
      const keysBudget = Math.max(10, Math.min(22, Math.floor(leftW * 0.34)));
      const clippedKeys = truncateAnsi(keysText, keysBudget);
      const labelBudget = Math.max(10, leftW - visibleLength(clippedKeys) - ctxTag.length - 7);
      const clippedLabel = truncateAnsi(stripUnsafeAnsi(def.label), labelBudget);

      if (isSelected) {
        const prefix = state.captureMode ? ' ◉ ' : ' ▸ ';
        const leftPart = `${prefix}${marker} ${ctxTag}${clippedLabel}`;
        const gap = ' '.repeat(Math.max(1, leftW - visibleLength(leftPart) - visibleLength(clippedKeys) - 1));
        leftStr = `${bg(theme.selectionBg)}${fg(theme.selectionFg)}${BOLD}${fitAnsi(`${leftPart}${gap}${clippedKeys} `, leftW)}${RESET}`;
      } else {
        const markerColored = hasConflict
          ? `${fg(theme.warning)}${BOLD}⚠${RESET}`
          : modified
            ? `${fg(theme.accent)}*${RESET}`
            : ' ';
        const ctxColored = ctxTag ? `${fg(theme.muted)}${DIM}${ctxTag}${RESET}` : '';
        const leftPart = `   ${markerColored} ${ctxColored}${fg(theme.text)}${clippedLabel}${RESET}`;
        const keyColored = `${fg(hasConflict ? theme.warning : theme.accent)}${clippedKeys}${RESET}`;
        const gap = ' '.repeat(Math.max(1, leftW - visibleLength(leftPart) - visibleLength(keyColored) - 1));
        leftStr = fitAnsi(`${leftPart}${gap}${keyColored} `, leftW);
      }
    } else if (r === 0 && items.length === 0) {
      leftStr = fitAnsi(` ${fg(theme.muted)}${ITALIC}(nenhuma ação encontrada para o filtro)${RESET}`, leftW);
    } else {
      leftStr = ' '.repeat(leftW);
    }

    if (useTwoPanes) {
      const rightStr = fitAnsi(detailLines[r] ?? '', rightW);
      rows.push(`${leftStr}${sep}${rightStr}`);
    } else {
      rows.push(leftStr);
    }
  }

  rows.push(footerLine);
  return rows;
}

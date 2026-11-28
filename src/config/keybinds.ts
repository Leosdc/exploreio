/**
 * Exploreio Custom Keybinds Configuration & Registry (SPEC-006)
 * Gerencia o catálogo tipado de ações por contexto, normalização/matching
 * de KeyEvent <-> strings de atalho, detecção de conflitos e persistência
 * fail-safe em ~/.exploreiorc.json.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ThemeName } from '../themes/palette.js';
import { stripUnsafeAnsi } from '../tui/ansi.js';
import type { KeyEvent } from '../tui/input.js';

export type KeybindContext = 'global' | 'browser' | 'reader' | 'git';

export type KeybindActionId =
  | 'global.quit'
  | 'global.help'
  | 'global.openKeybinds'
  | 'global.cycleTheme'
  | 'browser.moveUp'
  | 'browser.moveDown'
  | 'browser.pageUp'
  | 'browser.pageDown'
  | 'browser.goTop'
  | 'browser.goBottom'
  | 'browser.open'
  | 'browser.parentDir'
  | 'browser.filter'
  | 'browser.toggleHidden'
  | 'browser.createEntry'
  | 'browser.renameEntry'
  | 'browser.deleteEntry'
  | 'browser.copyPath'
  | 'browser.openEditor'
  | 'browser.openFullscreen'
  | 'browser.openGitPanel'
  | 'browser.refresh'
  | 'reader.back'
  | 'reader.moveUp'
  | 'reader.moveDown'
  | 'reader.pageUp'
  | 'reader.pageDown'
  | 'reader.goTop'
  | 'reader.goBottom'
  | 'reader.toggleMode'
  | 'reader.search'
  | 'reader.searchNext'
  | 'reader.searchPrev'
  | 'reader.copyPath'
  | 'reader.openEditor'
  | 'reader.openFullscreen'
  | 'reader.openGitPanel'
  | 'reader.jsonToggleNode'
  | 'reader.jsonExpandNode'
  | 'reader.jsonCollapseNode'
  | 'reader.jsonExpandAll'
  | 'reader.jsonCollapseAll'
  | 'git.back'
  | 'git.nextTab'
  | 'git.prevTab'
  | 'git.moveUp'
  | 'git.moveDown'
  | 'git.detailUp'
  | 'git.detailDown'
  | 'git.stageToggle'
  | 'git.stageAll'
  | 'git.unstageAll'
  | 'git.commit'
  | 'git.pull'
  | 'git.push'
  | 'git.fetch'
  | 'git.createBranch'
  | 'git.stashPush'
  | 'git.stashPop'
  | 'git.discard'
  | 'git.copyItem'
  | 'git.openItem'
  | 'git.quickPalette'
  | 'git.refresh';

export interface KeybindDefinition {
  readonly id: KeybindActionId;
  readonly context: KeybindContext;
  readonly action: string;
  readonly label: string;
  readonly description: string;
  readonly defaultKeys: readonly string[];
}

export type KeybindsConfigMap = Partial<Record<KeybindContext, Record<string, string[]>>>;

export interface ExploreioConfigFile {
  theme?: ThemeName;
  keybinds?: KeybindsConfigMap;
}

export interface KeybindConflict {
  readonly context: KeybindContext;
  readonly key: string;
  readonly actions: readonly KeybindActionId[];
}

export interface LoadKeybindsResult {
  readonly registry: KeybindRegistry;
  readonly configPath: string;
  readonly loadedFromFile: boolean;
  readonly warning?: string;
}

const MAX_CONFIG_BYTES = 256 * 1024;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const NAMED_KEY_ALIASES: Record<string, string> = {
  up: 'up',
  arrowup: 'up',
  down: 'down',
  arrowdown: 'down',
  left: 'left',
  arrowleft: 'left',
  right: 'right',
  arrowright: 'right',
  enter: 'enter',
  return: 'enter',
  tab: 'tab',
  'shift+tab': 'shift+tab',
  backtab: 'shift+tab',
  esc: 'escape',
  escape: 'escape',
  bksp: 'backspace',
  backspace: 'backspace',
  del: 'delete',
  delete: 'delete',
  space: 'space',
  spacebar: 'space',
  pgup: 'pageup',
  pageup: 'pageup',
  pgdn: 'pagedown',
  pagedown: 'pagedown',
  home: 'home',
  end: 'end',
};

const DISPLAY_KEY_LABELS: Record<string, string> = {
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  enter: 'Enter',
  tab: 'Tab',
  'shift+tab': 'Shift+Tab',
  escape: 'Esc',
  backspace: 'Bksp',
  delete: 'Del',
  space: 'Space',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  home: 'Home',
  end: 'End',
};

export const CONTEXT_LABELS: Record<KeybindContext, string> = {
  global: 'Global',
  browser: 'Navegador',
  reader: 'Leitor',
  git: 'Painel Git',
};

export const DEFAULT_KEYBIND_DEFINITIONS: readonly KeybindDefinition[] = [
  // Global
  { id: 'global.quit', context: 'global', action: 'quit', label: 'Sair / Fechar', description: 'Sai do Exploreio no Navegador', defaultKeys: ['q'] },
  { id: 'global.help', context: 'global', action: 'help', label: 'Ajuda (?)', description: 'Abre ou fecha o modal de ajuda com os atalhos ativos', defaultKeys: ['?'] },
  { id: 'global.openKeybinds', context: 'global', action: 'openKeybinds', label: 'Painel de Binds', description: 'Abre o Painel Interativo de Edição de Keybinds', defaultKeys: ['K', 'ctrl+k'] },
  { id: 'global.cycleTheme', context: 'global', action: 'cycleTheme', label: 'Trocar Tema', description: 'Alterna entre midnight, parchment e nord', defaultKeys: ['t'] },

  // Browser
  { id: 'browser.moveUp', context: 'browser', action: 'moveUp', label: 'Mover acima', description: 'Move a seleção um item para cima', defaultKeys: ['up', 'k'] },
  { id: 'browser.moveDown', context: 'browser', action: 'moveDown', label: 'Mover abaixo', description: 'Move a seleção um item para baixo', defaultKeys: ['down', 'j'] },
  { id: 'browser.pageUp', context: 'browser', action: 'pageUp', label: 'Página acima', description: 'Avança 10 itens para cima na lista', defaultKeys: ['pageup'] },
  { id: 'browser.pageDown', context: 'browser', action: 'pageDown', label: 'Página abaixo', description: 'Avança 10 itens para baixo na lista', defaultKeys: ['pagedown'] },
  { id: 'browser.goTop', context: 'browser', action: 'goTop', label: 'Ir ao topo', description: 'Seleciona o primeiro item da pasta', defaultKeys: ['home', 'g'] },
  { id: 'browser.goBottom', context: 'browser', action: 'goBottom', label: 'Ir ao fim', description: 'Seleciona o último item da pasta', defaultKeys: ['end', 'G'] },
  { id: 'browser.open', context: 'browser', action: 'open', label: 'Abrir / Entrar', description: 'Entra na pasta ou abre arquivo no Leitor Fullscreen', defaultKeys: ['enter', 'right', 'l'] },
  { id: 'browser.parentDir', context: 'browser', action: 'parentDir', label: 'Diretório pai', description: 'Volta para o diretório pai', defaultKeys: ['left', 'backspace', 'h'] },
  { id: 'browser.filter', context: 'browser', action: 'filter', label: 'Filtrar pasta', description: 'Ativa filtro fuzzy instantâneo no diretório atual', defaultKeys: ['/', 'f'] },
  { id: 'browser.toggleHidden', context: 'browser', action: 'toggleHidden', label: 'Arquivos ocultos', description: 'Exibe ou oculta arquivos iniciados por ponto', defaultKeys: ['.'] },
  { id: 'browser.createEntry', context: 'browser', action: 'createEntry', label: 'Criar arquivo/pasta', description: 'Cria novo arquivo ou pasta (terminando com /)', defaultKeys: ['a'] },
  { id: 'browser.renameEntry', context: 'browser', action: 'renameEntry', label: 'Renomear', description: 'Renomeia o arquivo ou pasta selecionado', defaultKeys: ['r'] },
  { id: 'browser.deleteEntry', context: 'browser', action: 'deleteEntry', label: 'Excluir', description: 'Exclui o item selecionado (com confirmação)', defaultKeys: ['d'] },
  { id: 'browser.copyPath', context: 'browser', action: 'copyPath', label: 'Copiar caminho', description: 'Copia o caminho completo para a área de transferência', defaultKeys: ['y'] },
  { id: 'browser.openEditor', context: 'browser', action: 'openEditor', label: 'Editor Vim', description: 'Abre o arquivo selecionado no Editor Modal Vim', defaultKeys: ['e'] },
  { id: 'browser.openFullscreen', context: 'browser', action: 'openFullscreen', label: 'Abrir Fullscreen', description: 'Abre o arquivo em novo terminal em tela cheia', defaultKeys: ['o', 'F'] },
  { id: 'browser.openGitPanel', context: 'browser', action: 'openGitPanel', label: 'Painel Git', description: 'Abre o Painel Git & GitHub nativo', defaultKeys: ['tab', 'ctrl+g'] },
  { id: 'browser.refresh', context: 'browser', action: 'refresh', label: 'Recarregar pasta', description: 'Recarrega a listagem do diretório atual', defaultKeys: ['R'] },

  // Reader
  { id: 'reader.back', context: 'reader', action: 'back', label: 'Voltar ao Navegador', description: 'Fecha o Leitor e retorna ao Navegador', defaultKeys: ['escape', 'q', 'backspace'] },
  { id: 'reader.moveUp', context: 'reader', action: 'moveUp', label: 'Rolar acima', description: 'Move uma linha acima no documento', defaultKeys: ['up', 'k'] },
  { id: 'reader.moveDown', context: 'reader', action: 'moveDown', label: 'Rolar abaixo', description: 'Move uma linha abaixo no documento', defaultKeys: ['down', 'j'] },
  { id: 'reader.pageUp', context: 'reader', action: 'pageUp', label: 'Página acima', description: 'Rola uma página para cima', defaultKeys: ['pageup', 'b'] },
  { id: 'reader.pageDown', context: 'reader', action: 'pageDown', label: 'Página abaixo', description: 'Rola uma página para baixo', defaultKeys: ['pagedown', 'space'] },
  { id: 'reader.goTop', context: 'reader', action: 'goTop', label: 'Ir ao início', description: 'Vai para o topo do documento', defaultKeys: ['home', 'g'] },
  { id: 'reader.goBottom', context: 'reader', action: 'goBottom', label: 'Ir ao fim', description: 'Vai para o final do documento', defaultKeys: ['end', 'G'] },
  { id: 'reader.toggleMode', context: 'reader', action: 'toggleMode', label: 'Alternar modo', description: 'Alterna Rendered↔Raw, Tree↔Pretty ou Reader↔Source', defaultKeys: ['tab'] },
  { id: 'reader.search', context: 'reader', action: 'search', label: 'Buscar texto', description: 'Inicia busca textual no documento aberto', defaultKeys: ['/'] },
  { id: 'reader.searchNext', context: 'reader', action: 'searchNext', label: 'Próxima ocorrência', description: 'Salta para a próxima ocorrência da busca', defaultKeys: ['n'] },
  { id: 'reader.searchPrev', context: 'reader', action: 'searchPrev', label: 'Ocorrência anterior', description: 'Salta para a ocorrência anterior da busca', defaultKeys: ['N'] },
  { id: 'reader.copyPath', context: 'reader', action: 'copyPath', label: 'Copiar caminho', description: 'Copia o caminho do arquivo aberto', defaultKeys: ['y'] },
  { id: 'reader.openEditor', context: 'reader', action: 'openEditor', label: 'Editor Vim', description: 'Abre o documento atual no Editor Vim (use E no JSON Tree)', defaultKeys: ['e', 'E'] },
  { id: 'reader.openFullscreen', context: 'reader', action: 'openFullscreen', label: 'Abrir Fullscreen', description: 'Abre o documento em novo terminal em tela cheia', defaultKeys: ['o', 'F'] },
  { id: 'reader.openGitPanel', context: 'reader', action: 'openGitPanel', label: 'Painel Git', description: 'Abre o Painel Git diretamente do Leitor', defaultKeys: ['ctrl+g'] },
  { id: 'reader.jsonToggleNode', context: 'reader', action: 'jsonToggleNode', label: 'JSON: Alternar nó', description: 'Expande ou recolhe o nó JSON selecionado', defaultKeys: ['enter', 'space'] },
  { id: 'reader.jsonExpandNode', context: 'reader', action: 'jsonExpandNode', label: 'JSON: Expandir nó', description: 'Expande o nó JSON selecionado', defaultKeys: ['right', 'l'] },
  { id: 'reader.jsonCollapseNode', context: 'reader', action: 'jsonCollapseNode', label: 'JSON: Recolher nó', description: 'Recolhe o nó JSON selecionado', defaultKeys: ['left', 'h'] },
  { id: 'reader.jsonExpandAll', context: 'reader', action: 'jsonExpandAll', label: 'JSON: Expandir tudo', description: 'Expande todos os nós na JSON Tree', defaultKeys: ['e'] },
  { id: 'reader.jsonCollapseAll', context: 'reader', action: 'jsonCollapseAll', label: 'JSON: Recolher tudo', description: 'Recolhe todos os nós na JSON Tree', defaultKeys: ['c'] },

  // Git Panel
  { id: 'git.back', context: 'git', action: 'back', label: 'Voltar ao Navegador', description: 'Fecha o Painel Git e retorna ao Navegador', defaultKeys: ['escape', 'q'] },
  { id: 'git.nextTab', context: 'git', action: 'nextTab', label: 'Próxima aba', description: 'Avança para a próxima aba do Painel Git', defaultKeys: ['tab'] },
  { id: 'git.prevTab', context: 'git', action: 'prevTab', label: 'Aba anterior', description: 'Retorna para a aba anterior do Painel Git', defaultKeys: ['shift+tab'] },
  { id: 'git.moveUp', context: 'git', action: 'moveUp', label: 'Item acima', description: 'Move a seleção para o item anterior', defaultKeys: ['up', 'k'] },
  { id: 'git.moveDown', context: 'git', action: 'moveDown', label: 'Item abaixo', description: 'Move a seleção para o próximo item', defaultKeys: ['down', 'j'] },
  { id: 'git.detailUp', context: 'git', action: 'detailUp', label: 'Diff acima', description: 'Rola o painel de diff/detalhes para cima', defaultKeys: ['pageup', 'K'] },
  { id: 'git.detailDown', context: 'git', action: 'detailDown', label: 'Diff abaixo', description: 'Rola o painel de diff/detalhes para baixo', defaultKeys: ['pagedown', 'J'] },
  { id: 'git.stageToggle', context: 'git', action: 'stageToggle', label: 'Stage / Unstage', description: 'Alterna stage do arquivo selecionado', defaultKeys: ['s', 'space'] },
  { id: 'git.stageAll', context: 'git', action: 'stageAll', label: 'Stage All', description: 'Adiciona todas as alterações ao stage', defaultKeys: ['S'] },
  { id: 'git.unstageAll', context: 'git', action: 'unstageAll', label: 'Unstage All', description: 'Remove todas as alterações do stage', defaultKeys: ['U'] },
  { id: 'git.commit', context: 'git', action: 'commit', label: 'Commit', description: 'Abre prompt para criar commit das alterações staged', defaultKeys: ['c'] },
  { id: 'git.pull', context: 'git', action: 'pull', label: 'Git Pull', description: 'Executa git pull na branch atual', defaultKeys: ['p'] },
  { id: 'git.push', context: 'git', action: 'push', label: 'Git Push', description: 'Envia commits locais para o remoto', defaultKeys: ['P'] },
  { id: 'git.fetch', context: 'git', action: 'fetch', label: 'Git Fetch', description: 'Atualiza referências remotas', defaultKeys: ['f'] },
  { id: 'git.createBranch', context: 'git', action: 'createBranch', label: 'Nova Branch', description: 'Cria e muda para uma nova branch', defaultKeys: ['b'] },
  { id: 'git.stashPush', context: 'git', action: 'stashPush', label: 'Stash Push', description: 'Salva alterações locais no stash', defaultKeys: ['z'] },
  { id: 'git.stashPop', context: 'git', action: 'stashPop', label: 'Stash Pop', description: 'Restaura o último stash', defaultKeys: ['Z'] },
  { id: 'git.discard', context: 'git', action: 'discard', label: 'Descartar arquivo', description: 'Descarta alterações do arquivo (com confirmação)', defaultKeys: ['x'] },
  { id: 'git.copyItem', context: 'git', action: 'copyItem', label: 'Copiar item Git', description: 'Copia hash, caminho, branch ou URL do item', defaultKeys: ['y'] },
  { id: 'git.openItem', context: 'git', action: 'openItem', label: 'Abrir / Checkout', description: 'Abre arquivo no Leitor, faz checkout de branch ou copia URL', defaultKeys: ['enter'] },
  { id: 'git.quickPalette', context: 'git', action: 'quickPalette', label: 'Paleta Git', description: 'Abre a paleta interativa de ações rápidas Git', defaultKeys: ['?'] },
  { id: 'git.refresh', context: 'git', action: 'refresh', label: 'Atualizar Git', description: 'Recarrega status, commits, branches e PRs', defaultKeys: ['r'] },
];

const DEFINITIONS_BY_ID = new Map<KeybindActionId, KeybindDefinition>(
  DEFAULT_KEYBIND_DEFINITIONS.map((def) => [def.id, def])
);

export function getDefaultConfigPath(): string {
  return path.join(os.homedir(), '.exploreiorc.json');
}

export function normalizeKeySpec(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  if (raw === ' ') return 'space';

  const clean = stripUnsafeAnsi(raw).trim();
  if (!clean || clean.length > 24) return null;

  const lower = clean.toLowerCase();
  if (NAMED_KEY_ALIASES[lower]) {
    return NAMED_KEY_ALIASES[lower];
  }

  const ctrlMatch = lower.match(/^ctrl\+([a-z])$/);
  if (ctrlMatch && ctrlMatch[1]) {
    return `ctrl+${ctrlMatch[1]}`;
  }

  // Caractere imprimível único (preservando maiúsculas/minúsculas)
  const chars = Array.from(clean);
  if (chars.length === 1) {
    const ch = chars[0] ?? '';
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 33 && code !== 127) {
      return ch;
    }
  }

  return null;
}

export function formatKeyEvent(ev: KeyEvent): string | null {
  if (ev.name === 'wheel_up' || ev.name === 'wheel_down') return null;

  if (ev.ctrl && ev.name) {
    return normalizeKeySpec(`ctrl+${ev.name}`);
  }
  if (ev.shift && ev.name === 'tab') {
    return 'shift+tab';
  }
  if (ev.name === 'char' && ev.char) {
    return normalizeKeySpec(ev.char);
  }
  return normalizeKeySpec(ev.name);
}

export function formatKeyForDisplay(spec: string): string {
  const normalized = normalizeKeySpec(spec);
  if (!normalized) return stripUnsafeAnsi(spec);
  if (DISPLAY_KEY_LABELS[normalized]) {
    return DISPLAY_KEY_LABELS[normalized];
  }
  if (normalized.startsWith('ctrl+')) {
    return `Ctrl+${normalized.slice(5).toUpperCase()}`;
  }
  return normalized;
}

function dedupeValidKeys(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of keys) {
    const norm = normalizeKeySpec(raw);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class KeybindRegistry {
  private readonly bindings = new Map<KeybindActionId, string[]>();

  constructor(overrides?: KeybindsConfigMap) {
    for (const def of DEFAULT_KEYBIND_DEFINITIONS) {
      const ctxRecord = overrides?.[def.context];
      const rawOverride =
        ctxRecord &&
        !FORBIDDEN_KEYS.has(def.action) &&
        Object.prototype.hasOwnProperty.call(ctxRecord, def.action)
          ? ctxRecord[def.action]
          : undefined;

      if (Array.isArray(rawOverride)) {
        const cleaned = dedupeValidKeys(rawOverride);
        this.bindings.set(def.id, cleaned.length > 0 ? cleaned : [...def.defaultKeys]);
      } else {
        this.bindings.set(def.id, [...def.defaultKeys]);
      }
    }
  }

  public getDefinition(id: KeybindActionId): KeybindDefinition | undefined {
    return DEFINITIONS_BY_ID.get(id);
  }

  public getDefinitions(context?: KeybindContext): readonly KeybindDefinition[] {
    if (!context) return DEFAULT_KEYBIND_DEFINITIONS;
    return DEFAULT_KEYBIND_DEFINITIONS.filter((d) => d.context === context);
  }

  public getKeys(id: KeybindActionId): readonly string[] {
    return this.bindings.get(id) ?? [];
  }

  public formatActionKeys(id: KeybindActionId, separator = ' / '): string {
    const keys = this.getKeys(id);
    if (keys.length === 0) return '(sem tecla)';
    return keys.map(formatKeyForDisplay).join(separator);
  }

  public matches(id: KeybindActionId, ev: KeyEvent): boolean {
    const spec = formatKeyEvent(ev);
    if (!spec) return false;
    const keys = this.bindings.get(id);
    return Boolean(keys && keys.includes(spec));
  }

  public isModified(id: KeybindActionId): boolean {
    const def = DEFINITIONS_BY_ID.get(id);
    if (!def) return false;
    const current = this.getKeys(id);
    if (current.length !== def.defaultKeys.length) return true;
    return current.some((k, idx) => k !== def.defaultKeys[idx]);
  }

  public setKeys(id: KeybindActionId, keys: readonly string[]): boolean {
    if (!DEFINITIONS_BY_ID.has(id)) return false;
    const cleaned = dedupeValidKeys(keys);
    if (cleaned.length === 0) return false;
    this.bindings.set(id, cleaned);
    return true;
  }

  public replacePrimaryKey(id: KeybindActionId, rawKey: string): boolean {
    const norm = normalizeKeySpec(rawKey);
    if (!norm || !DEFINITIONS_BY_ID.has(id)) return false;
    const existing = this.getKeys(id).filter((k) => k !== norm);
    const rest = existing.slice(1);
    this.bindings.set(id, [norm, ...rest]);
    return true;
  }

  public addKey(id: KeybindActionId, rawKey: string): boolean {
    const norm = normalizeKeySpec(rawKey);
    if (!norm || !DEFINITIONS_BY_ID.has(id)) return false;
    const current = [...this.getKeys(id)];
    if (current.includes(norm)) return false;
    current.push(norm);
    this.bindings.set(id, current);
    return true;
  }

  public removeLastKey(id: KeybindActionId): boolean {
    const current = [...this.getKeys(id)];
    if (current.length <= 1) return false;
    current.pop();
    this.bindings.set(id, current);
    return true;
  }

  public resetAction(id: KeybindActionId): boolean {
    const def = DEFINITIONS_BY_ID.get(id);
    if (!def) return false;
    this.bindings.set(id, [...def.defaultKeys]);
    return true;
  }

  public resetAll(): void {
    for (const def of DEFAULT_KEYBIND_DEFINITIONS) {
      this.bindings.set(def.id, [...def.defaultKeys]);
    }
  }

  public findConflicts(context?: KeybindContext): KeybindConflict[] {
    const contexts: readonly KeybindContext[] = context ? [context] : ['global', 'browser', 'reader', 'git'];
    const conflicts: KeybindConflict[] = [];

    for (const ctx of contexts) {
      const byKey = new Map<string, KeybindActionId[]>();
      for (const def of this.getDefinitions(ctx)) {
        for (const key of this.getKeys(def.id)) {
          const list = byKey.get(key) ?? [];
          list.push(def.id);
          byKey.set(key, list);
        }
      }
      for (const [key, actions] of byKey.entries()) {
        if (actions.length > 1) {
          // Exceção intencional de contexto interno no JSON Tree:
          // reader.openEditor ('e'/'E') convive com reader.jsonExpandAll ('e'),
          // reader.pageDown ('space') convive com reader.jsonToggleNode ('space').
          const isIntentionalJsonPair =
            ctx === 'reader' &&
            actions.every(
              (a) =>
                a === 'reader.openEditor' ||
                a === 'reader.jsonExpandAll' ||
                a === 'reader.pageDown' ||
                a === 'reader.jsonToggleNode'
            ) &&
            !(actions.includes('reader.openEditor') && actions.includes('reader.pageDown'));

          if (!isIntentionalJsonPair) {
            conflicts.push({ context: ctx, key, actions });
          }
        }
      }
    }

    return conflicts;
  }

  public getConflictsForAction(id: KeybindActionId): KeybindConflict[] {
    const def = DEFINITIONS_BY_ID.get(id);
    if (!def) return [];
    return this.findConflicts(def.context).filter((c) => c.actions.includes(id));
  }

  public toConfigMap(): KeybindsConfigMap {
    const result: KeybindsConfigMap = {};
    for (const def of DEFAULT_KEYBIND_DEFINITIONS) {
      const ctxMap = (result[def.context] ??= {});
      ctxMap[def.action] = [...this.getKeys(def.id)];
    }
    return result;
  }
}

function sanitizeConfigKeybinds(raw: unknown): KeybindsConfigMap {
  if (!isPlainObject(raw)) return {};
  const result: KeybindsConfigMap = {};
  const validContexts: readonly KeybindContext[] = ['global', 'browser', 'reader', 'git'];

  for (const ctx of validContexts) {
    if (!Object.prototype.hasOwnProperty.call(raw, ctx)) continue;
    const rawCtx = raw[ctx];
    if (!isPlainObject(rawCtx)) continue;

    const cleanCtx: Record<string, string[]> = {};
    for (const [action, value] of Object.entries(rawCtx)) {
      if (FORBIDDEN_KEYS.has(action)) continue;
      if (Array.isArray(value)) {
        const stringKeys = value.filter((item): item is string => typeof item === 'string');
        const normalized = dedupeValidKeys(stringKeys);
        if (normalized.length > 0) cleanCtx[action] = normalized;
      } else if (typeof value === 'string') {
        const norm = normalizeKeySpec(value);
        if (norm) cleanCtx[action] = [norm];
      }
    }
    result[ctx] = cleanCtx;
  }
  return result;
}

function readRawConfigObject(configPath: string): { data: Record<string, unknown>; exists: boolean; error?: string } {
  try {
    if (!fs.existsSync(configPath)) return { data: {}, exists: false };
    const stat = fs.statSync(configPath);
    if (stat.size > MAX_CONFIG_BYTES) {
      return { data: {}, exists: true, error: `Arquivo de configuração excede ${MAX_CONFIG_BYTES} bytes.` };
    }
    const rawText = fs.readFileSync(configPath, 'utf8');
    const parsed: unknown = JSON.parse(rawText);
    if (!isPlainObject(parsed)) {
      return { data: {}, exists: true, error: 'Configuração inválida: esperado objeto JSON na raiz.' };
    }
    return { data: parsed, exists: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { data: {}, exists: true, error: `Falha ao ler configuração (${msg}). Usando padrões.` };
  }
}

export function loadKeybindsRegistry(configPath: string = getDefaultConfigPath()): LoadKeybindsResult {
  const { data, exists, error } = readRawConfigObject(configPath);
  if (error) {
    return {
      registry: new KeybindRegistry(),
      configPath,
      loadedFromFile: false,
      warning: error,
    };
  }
  const keybinds = sanitizeConfigKeybinds(data.keybinds);
  return {
    registry: new KeybindRegistry(keybinds),
    configPath,
    loadedFromFile: exists,
  };
}

export function saveKeybindsConfig(
  registry: KeybindRegistry,
  configPath: string = getDefaultConfigPath(),
  themeOverride?: ThemeName
): { ok: boolean; error?: string } {
  try {
    const existing = readRawConfigObject(configPath);
    const nextData: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(existing.data)) {
      if (!FORBIDDEN_KEYS.has(key) && key !== 'keybinds') {
        nextData[key] = value;
      }
    }

    if (themeOverride) {
      nextData.theme = themeOverride;
    } else if (typeof nextData.theme !== 'string') {
      nextData.theme = 'midnight';
    }

    nextData.keybinds = registry.toConfigMap();

    const dir = path.dirname(configPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(nextData, null, 2)}\n`, 'utf8');
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function initBaseConfigFile(
  configPath: string = getDefaultConfigPath(),
  options: { force?: boolean; theme?: ThemeName } = {}
): { ok: boolean; created: boolean; configPath: string; error?: string } {
  const exists = fs.existsSync(configPath);
  if (exists && !options.force) {
    const current = loadKeybindsRegistry(configPath);
    const saved = saveKeybindsConfig(current.registry, configPath, options.theme);
    return { ok: saved.ok, created: false, configPath, error: saved.error };
  }

  const registry = new KeybindRegistry();
  const saved = saveKeybindsConfig(registry, configPath, options.theme);
  return { ok: saved.ok, created: !exists, configPath, error: saved.error };
}

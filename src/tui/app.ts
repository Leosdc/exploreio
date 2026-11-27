/**
 * Exploreio TUI Application Controller (SPEC-001)
 * Navegador estilo Yazi (3 painéis: Pai | Atual | Preview Rico) + Modo Leitor
 * Fullscreen nativo no prompt com busca, JSON Tree interativo, Markdown rico,
 * HTML Reader/Source, Syntax Highlighting e 3 temas oficiais.
 */

import path from 'node:path';
import { VimEngine } from '../editor/vimEngine.js';
import { buildEditorFrame, type EditorViewport } from '../editor/vimView.js';
import {
  getGitSummaryBadge,
  gitCheckoutBranch,
  gitCommit,
  gitCreateBranch,
  gitDiscardFile,
  gitFetch,
  gitPull,
  gitPush,
  gitStageAll,
  gitStageFile,
  gitStashPop,
  gitStashPush,
  gitUnstageAll,
  gitUnstageFile,
  loadCommitDetails,
  loadFileDiff,
  loadGitHubData,
  loadGitPanelSnapshot,
  type GitHeaderSummary,
  type GitHubPanelData,
  type GitPanelSnapshot,
} from '../git/gitService.js';
import {
  buildGitHubListItems,
  buildGitPanelFrame,
  buildQuickActions,
  buildStatusListItems,
  formatGitHeaderBadge,
  type GitPanelTab,
  type GitQuickActionId,
} from '../git/gitView.js';
import {
  createFileOrDir,
  deleteEntry,
  formatBytes,
  readDirectoryEntries,
  renameEntry,
  safeReadFilePreview,
  safeWriteTextFile,
  type FileEntry,
  type SafeFilePreview,
} from '../fs/explorer.js';
import { collectAllCollapsiblePaths } from '../renderers/json.js';
import {
  renderDirectoryPreview,
  renderDocument,
  type RenderedDocument,
  type ViewMode,
} from '../renderers/index.js';
import { bg, fg, getTheme, nextTheme, type ThemeName, type ThemePalette } from '../themes/palette.js';
import { BOLD, DIM, ITALIC, RESET, fitAnsi, highlightSearch, stripUnsafeAnsi, truncateAnsi, visibleLength } from './ansi.js';
import { copyTextToClipboard } from './clipboard.js';
import { openInFullscreenShell } from './fullscreenLauncher.js';
import { parseInputChunk, type KeyEvent } from './input.js';
import { ScreenBuffer } from './screen.js';

type AppView = 'browser' | 'reader' | 'editor' | 'git';
type PromptKind =
  | null
  | 'filter'
  | 'search'
  | 'create'
  | 'rename'
  | 'delete'
  | 'git-commit'
  | 'git-branch-create'
  | 'git-confirm';

export interface ExploreioAppOptions {
  readonly startDir: string;
  readonly initialFile?: string;
  readonly initialMode?: ViewMode;
  readonly singleFile?: boolean;
  readonly themeName?: ThemeName;
  readonly showHidden?: boolean;
}

function getFileBadge(entry: FileEntry, theme: ThemePalette): string {
  if (entry.isDirectory) return `${fg(theme.dir)}${BOLD}▸${RESET}`;
  switch (entry.ext) {
    case '.md':
    case '.mdx':
      return `${fg(theme.accent)}${BOLD}M${RESET}`;
    case '.json':
    case '.jsonc':
      return `${fg(theme.warning)}${BOLD}{}${RESET}`;
    case '.html':
    case '.htm':
      return `${fg(theme.syntaxTag)}${BOLD}<>${RESET}`;
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
    case '.py':
    case '.rs':
    case '.go':
      return `${fg(theme.syntaxFunction)}${BOLD}λ${RESET}`;
    default:
      return `${fg(theme.muted)}·${RESET}`;
  }
}

export class ExploreioApp {
  private readonly screen = new ScreenBuffer();
  private readonly initialMode?: ViewMode;
  private readonly singleFile: boolean;
  private themeName: ThemeName;
  private view: AppView = 'browser';
  private showHidden: boolean;
  private showHelp = false;

  // Estado do navegador 3 painéis
  private currentDir: string;
  private parentEntries: FileEntry[] = [];
  private currentEntries: FileEntry[] = [];
  private selectedIndex = 0;
  private listScroll = 0;
  private filterQuery = '';

  // Preview & Leitor Fullscreen
  private previewLines: string[] = [];
  private previewBadge = '';
  private activeFilePreview: SafeFilePreview | null = null;
  private activeDoc: RenderedDocument | null = null;
  private preferredMode: ViewMode | undefined;
  private collapsedJsonPaths = new Set<string>();
  private readerScroll = 0;
  private readerCursor = 0;
  private readerSearchQuery = '';
  private readerSearchMatches: number[] = [];
  private readerSearchCursor = 0;

  // Editor modal estilo Vim (SPEC-002)
  private editorEngine: VimEngine | null = null;
  private editorFilePath = '';
  private editorReturnView: 'browser' | 'reader' = 'browser';
  private editorViewport: EditorViewport = { scrollY: 0, scrollX: 0 };
  private editorStatusMessage = '';
  private editorStatusIsError = false;
  private editorSavedAny = false;

  // Painel Git & GitHub + Badge no navegador (SPEC-005)
  private gitSummary: GitHeaderSummary | null = null;
  private gitSummarySeq = 0;
  private gitSnapshot: GitPanelSnapshot | null = null;
  private gitHubData: GitHubPanelData = {
    available: false,
    loading: false,
    repoSlug: null,
    pullRequests: [],
    issues: [],
    workflowRuns: [],
  };
  private gitTab: GitPanelTab = 'status';
  private gitSelectedIndex = 0;
  private gitListScroll = 0;
  private gitDetailTitle = '';
  private gitDetailLines: string[] = [];
  private gitDetailScroll = 0;
  private gitShowQuickPalette = false;
  private gitQuickPaletteIndex = 0;
  private gitBusyMessage = '';
  private gitPendingConfirm: { label: string; run: () => Promise<void> } | null = null;

  // Prompt modal inline (barra inferior)
  private promptKind: PromptKind = null;
  private promptInput = '';
  private toastMessage = '';
  private running = false;

  constructor(options: ExploreioAppOptions) {
    this.currentDir = path.resolve(options.startDir);
    this.initialMode = options.initialMode;
    this.singleFile = Boolean(options.singleFile);
    this.themeName = options.themeName ?? 'midnight';
    this.showHidden = Boolean(options.showHidden);
    if (options.initialFile) {
      this.currentDir = path.dirname(path.resolve(options.initialFile));
    }
  }

  public async start(initialFile?: string): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error('O modo interativo requer um terminal TTY. Use `--print <arquivo>` para saída direta.');
    }

    this.running = true;
    this.screen.enter();

    const cleanup = (): void => {
      this.running = false;
      this.screen.leave();
    };

    process.once('SIGINT', () => {
      cleanup();
      process.exit(0);
    });
    process.once('SIGTERM', () => {
      cleanup();
      process.exit(0);
    });
    process.stdout.on('resize', this.onResize);
    process.stdin.on('data', this.onStdinData);

    try {
      await this.reloadDirectory();
      if (initialFile) {
        const resolved = path.resolve(initialFile);
        const idx = this.currentEntries.findIndex((e) => e.fullPath === resolved);
        if (idx >= 0) this.selectedIndex = idx;
        await this.openFileInReader(resolved, this.initialMode);
      }
      this.draw();
    } catch (err) {
      cleanup();
      throw err;
    }
  }

  private shutdown(): void {
    this.running = false;
    process.stdout.off('resize', this.onResize);
    process.stdin.off('data', this.onStdinData);
    this.screen.leave();
  }

  private readonly onResize = (): void => {
    this.screen.forceClear();
    if (this.view === 'reader' && this.activeFilePreview) {
      this.rerenderReaderDoc();
    } else {
      void this.refreshSelectedPreview().then(() => this.draw());
    }
    this.draw();
  };

  private readonly onStdinData = (chunk: Buffer): void => {
    if (!this.running) return;
    const events = parseInputChunk(chunk.toString('utf8'));
    void this.handleEvents(events);
  };

  private async handleEvents(events: readonly KeyEvent[]): Promise<void> {
    for (const ev of events) {
      if (!this.running) return;
      if (ev.ctrl && ev.name === 'c') {
        this.shutdown();
        process.exit(0);
      }

      if (this.showHelp) {
        if (ev.name === 'escape' || ev.char === '?' || ev.char === 'q') {
          this.showHelp = false;
          this.draw();
        }
        continue;
      }

      if (this.promptKind) {
        await this.handlePromptKey(ev);
        continue;
      }

      if (this.view === 'editor') {
        await this.handleEditorKey(ev);
      } else if (this.view === 'git') {
        await this.handleGitKey(ev);
      } else if (this.view === 'reader') {
        await this.handleReaderKey(ev);
      } else {
        await this.handleBrowserKey(ev);
      }
    }
  }

  private async handlePromptKey(ev: KeyEvent): Promise<void> {
    if (ev.name === 'escape') {
      if (this.promptKind === 'filter') {
        this.filterQuery = '';
        await this.reloadDirectory();
      }
      this.promptKind = null;
      this.promptInput = '';
      this.draw();
      return;
    }

    if (ev.name === 'enter') {
      const kind = this.promptKind;
      const value = this.promptInput;
      this.promptKind = null;
      this.promptInput = '';

      if (kind === 'filter') {
        this.filterQuery = value;
        await this.reloadDirectory();
      } else if (kind === 'search') {
        this.readerSearchQuery = value.trim();
        this.recomputeSearchMatches();
        if (this.readerSearchMatches.length > 0) {
          this.readerSearchCursor = 0;
          this.jumpToMatch(0);
          this.toastMessage = `${this.readerSearchMatches.length} ocorrência(s) encontrada(s)`;
        } else if (this.readerSearchQuery) {
          this.toastMessage = `Nenhuma ocorrência para "${this.readerSearchQuery}"`;
        }
      } else if (kind === 'create' && value.trim()) {
        try {
          await createFileOrDir(this.currentDir, value);
          this.toastMessage = `Criado: ${value.trim()}`;
          await this.reloadDirectory();
        } catch (err) {
          this.toastMessage = err instanceof Error ? err.message : String(err);
        }
      } else if (kind === 'rename' && value.trim()) {
        const current = this.currentEntries[this.selectedIndex];
        if (current) {
          try {
            await renameEntry(current.fullPath, value);
            this.toastMessage = `Renomeado para: ${value.trim()}`;
            await this.reloadDirectory();
          } catch (err) {
            this.toastMessage = err instanceof Error ? err.message : String(err);
          }
        }
      } else if (kind === 'delete') {
        const current = this.currentEntries[this.selectedIndex];
        if (current && (value.trim().toLowerCase() === 'y' || value.trim().toLowerCase() === 's')) {
          try {
            await deleteEntry(current.fullPath);
            this.toastMessage = `Removido: ${current.name}`;
            await this.reloadDirectory();
          } catch (err) {
            this.toastMessage = err instanceof Error ? err.message : String(err);
          }
        } else {
          this.toastMessage = 'Exclusão cancelada.';
        }
      } else if (kind === 'git-commit') {
        await this.executeGitCommitPrompt(value);
      } else if (kind === 'git-branch-create') {
        await this.executeGitCreateBranchPrompt(value);
      } else if (kind === 'git-confirm') {
        const pending = this.gitPendingConfirm;
        this.gitPendingConfirm = null;
        if (pending && (value.trim().toLowerCase() === 'y' || value.trim().toLowerCase() === 's')) {
          await pending.run();
        } else {
          this.toastMessage = 'Operação Git cancelada.';
        }
      }
      this.draw();
      return;
    }

    if (ev.name === 'backspace') {
      this.promptInput = this.promptInput.slice(0, -1);
      if (this.promptKind === 'filter') {
        this.filterQuery = this.promptInput;
        await this.reloadDirectory();
      }
      this.draw();
      return;
    }

    if (ev.char) {
      this.promptInput += ev.char;
      if (this.promptKind === 'filter') {
        this.filterQuery = this.promptInput;
        await this.reloadDirectory();
      }
      this.draw();
    }
  }

  private async handleBrowserKey(ev: KeyEvent): Promise<void> {
    this.toastMessage = '';
    const maxIdx = Math.max(0, this.currentEntries.length - 1);

    if (ev.char === 'q') {
      this.shutdown();
      process.exit(0);
    }
    if (ev.char === '?') {
      this.showHelp = true;
      this.draw();
      return;
    }
    if (ev.char === 't') {
      this.themeName = nextTheme(this.themeName);
      this.toastMessage = `Tema ativo: ${getTheme(this.themeName).label}`;
      await this.refreshSelectedPreview();
      this.draw();
      return;
    }
    if (ev.char === '.') {
      this.showHidden = !this.showHidden;
      this.toastMessage = this.showHidden ? 'Exibindo arquivos ocultos' : 'Ocultando arquivos iniciados por "."';
      await this.reloadDirectory();
      this.draw();
      return;
    }
    if (ev.char === '/' || ev.char === 'f') {
      this.promptKind = 'filter';
      this.promptInput = this.filterQuery;
      this.draw();
      return;
    }
    if (ev.char === 'a') {
      this.promptKind = 'create';
      this.promptInput = '';
      this.draw();
      return;
    }
    if (ev.char === 'r' && this.currentEntries[this.selectedIndex]) {
      this.promptKind = 'rename';
      this.promptInput = this.currentEntries[this.selectedIndex]?.name ?? '';
      this.draw();
      return;
    }
    if (ev.char === 'd' && this.currentEntries[this.selectedIndex]) {
      this.promptKind = 'delete';
      this.promptInput = '';
      this.draw();
      return;
    }
    if (ev.char === 'y') {
      await this.copySelectedPath();
      return;
    }
    if (ev.char === 'o' || ev.char === 'F') {
      const entry = this.currentEntries[this.selectedIndex];
      if (entry && !entry.isDirectory) {
        await this.openInFullscreenTerminal(entry.fullPath);
      } else {
        this.toastMessage = 'Selecione um arquivo para abrir em terminal tela cheia (o).';
        this.draw();
      }
      return;
    }
    if (ev.name === 'tab' || (ev.ctrl && ev.name === 'g')) {
      await this.openGitPanel();
      return;
    }
    if (ev.char === 'e') {
      const entry = this.currentEntries[this.selectedIndex];
      if (entry && !entry.isDirectory) {
        await this.openFileInEditor(entry.fullPath, 'browser');
      } else {
        this.toastMessage = 'Selecione um arquivo de texto para abrir no editor Vim (e).';
        this.draw();
      }
      return;
    }

    if (ev.name === 'up' || ev.char === 'k' || ev.name === 'wheel_up') {
      if (this.selectedIndex > 0) {
        this.selectedIndex--;
        await this.refreshSelectedPreview();
      }
    } else if (ev.name === 'down' || ev.char === 'j' || ev.name === 'wheel_down') {
      if (this.selectedIndex < maxIdx) {
        this.selectedIndex++;
        await this.refreshSelectedPreview();
      }
    } else if (ev.name === 'pageup') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 10);
      await this.refreshSelectedPreview();
    } else if (ev.name === 'pagedown') {
      this.selectedIndex = Math.min(maxIdx, this.selectedIndex + 10);
      await this.refreshSelectedPreview();
    } else if (ev.name === 'home' || ev.char === 'g') {
      this.selectedIndex = 0;
      await this.refreshSelectedPreview();
    } else if (ev.name === 'end' || ev.char === 'G') {
      this.selectedIndex = maxIdx;
      await this.refreshSelectedPreview();
    } else if (ev.name === 'left' || ev.char === 'h' || ev.name === 'backspace') {
      const parent = path.dirname(this.currentDir);
      if (parent !== this.currentDir) {
        const previousName = path.basename(this.currentDir);
        this.currentDir = parent;
        this.filterQuery = '';
        await this.reloadDirectory(previousName);
      }
    } else if (ev.name === 'enter' || ev.name === 'right' || ev.char === 'l') {
      const entry = this.currentEntries[this.selectedIndex];
      if (!entry) return;
      if (entry.isDirectory) {
        this.currentDir = entry.fullPath;
        this.filterQuery = '';
        this.selectedIndex = 0;
        this.listScroll = 0;
        await this.reloadDirectory();
      } else {
        await this.openFileInReader(entry.fullPath);
      }
    }

    this.draw();
  }

  private async handleReaderKey(ev: KeyEvent): Promise<void> {
    this.toastMessage = '';
    const { height } = this.screen.getSize();
    const bodyHeight = Math.max(4, height - 3);
    const totalLines = this.activeDoc?.lines.length ?? 0;
    const isJsonTree = this.activeDoc?.kind === 'json' && this.activeDoc.activeMode === 'tree';

    if (ev.name === 'escape' || ev.char === 'q' || ev.name === 'backspace') {
      if (this.singleFile) {
        this.shutdown();
        process.exit(0);
      }
      this.view = 'browser';
      this.readerSearchQuery = '';
      this.readerSearchMatches = [];
      await this.refreshSelectedPreview();
      this.draw();
      return;
    }
    if (ev.char === '?') {
      this.showHelp = true;
      this.draw();
      return;
    }
    if (ev.char === 't') {
      this.themeName = nextTheme(this.themeName);
      this.toastMessage = `Tema ativo: ${getTheme(this.themeName).label}`;
      this.rerenderReaderDoc();
      this.draw();
      return;
    }
    if (ev.char === 'y') {
      await this.copySelectedPath();
      return;
    }
    if ((ev.char === 'o' || ev.char === 'F') && this.activeFilePreview) {
      await this.openInFullscreenTerminal(this.activeFilePreview.filePath, this.activeDoc?.activeMode);
      return;
    }
    if (ev.ctrl && ev.name === 'g') {
      await this.openGitPanel();
      return;
    }
    if ((ev.char === 'E' || (ev.char === 'e' && !isJsonTree)) && this.activeFilePreview) {
      await this.openFileInEditor(this.activeFilePreview.filePath, 'reader');
      return;
    }
    if (ev.name === 'tab' && this.activeDoc && this.activeDoc.modes.length > 1) {
      const idx = this.activeDoc.modes.indexOf(this.activeDoc.activeMode);
      this.preferredMode = this.activeDoc.modes[(idx + 1) % this.activeDoc.modes.length];
      this.readerScroll = 0;
      this.readerCursor = 0;
      this.rerenderReaderDoc();
      this.toastMessage = `Modo: ${this.activeDoc?.badge ?? ''}`;
      this.draw();
      return;
    }
    if (ev.char === '/') {
      this.promptKind = 'search';
      this.promptInput = this.readerSearchQuery;
      this.draw();
      return;
    }
    if (ev.char === 'n' && this.readerSearchMatches.length > 0) {
      this.readerSearchCursor = (this.readerSearchCursor + 1) % this.readerSearchMatches.length;
      this.jumpToMatch(this.readerSearchCursor);
      this.draw();
      return;
    }
    if (ev.char === 'N' && this.readerSearchMatches.length > 0) {
      this.readerSearchCursor =
        (this.readerSearchCursor - 1 + this.readerSearchMatches.length) % this.readerSearchMatches.length;
      this.jumpToMatch(this.readerSearchCursor);
      this.draw();
      return;
    }

    // Interações exclusivas da Árvore JSON (expandir/recolher)
    if (isJsonTree && this.activeDoc) {
      const row = this.activeDoc.jsonTreeRows[this.readerCursor];
      if (ev.name === 'enter' || ev.name === 'space') {
        if (row?.collapsible) {
          if (this.collapsedJsonPaths.has(row.path)) this.collapsedJsonPaths.delete(row.path);
          else this.collapsedJsonPaths.add(row.path);
          this.rerenderReaderDoc();
        }
        this.draw();
        return;
      }
      if (ev.name === 'left' || ev.char === 'h') {
        if (row?.collapsible && !row.collapsed) {
          this.collapsedJsonPaths.add(row.path);
          this.rerenderReaderDoc();
        }
        this.draw();
        return;
      }
      if (ev.name === 'right' || ev.char === 'l') {
        if (row?.collapsible && row.collapsed) {
          this.collapsedJsonPaths.delete(row.path);
          this.rerenderReaderDoc();
        }
        this.draw();
        return;
      }
      if (ev.char === 'e') {
        this.collapsedJsonPaths.clear();
        this.rerenderReaderDoc();
        this.toastMessage = 'Todos os nós JSON expandidos';
        this.draw();
        return;
      }
      if (ev.char === 'c' && this.activeFilePreview) {
        try {
          const parsed: unknown = JSON.parse(this.activeFilePreview.text);
          const all = collectAllCollapsiblePaths(parsed).filter((p) => p !== '$');
          this.collapsedJsonPaths = new Set(all);
          this.readerCursor = 0;
          this.readerScroll = 0;
          this.rerenderReaderDoc();
          this.toastMessage = 'Nós JSON recolhidos';
        } catch {
          // Ignora se JSON inválido
        }
        this.draw();
        return;
      }
    }

    // Scroll & navegação vertical no leitor
    const maxScroll = Math.max(0, totalLines - bodyHeight);
    if (ev.name === 'up' || ev.char === 'k' || ev.name === 'wheel_up') {
      if (isJsonTree) {
        this.readerCursor = Math.max(0, this.readerCursor - 1);
        if (this.readerCursor < this.readerScroll) this.readerScroll = this.readerCursor;
      } else {
        this.readerScroll = Math.max(0, this.readerScroll - (ev.name === 'wheel_up' ? 3 : 1));
      }
    } else if (ev.name === 'down' || ev.char === 'j' || ev.name === 'wheel_down') {
      if (isJsonTree) {
        this.readerCursor = Math.min(Math.max(0, totalLines - 1), this.readerCursor + 1);
        if (this.readerCursor >= this.readerScroll + bodyHeight) {
          this.readerScroll = this.readerCursor - bodyHeight + 1;
        }
      } else {
        this.readerScroll = Math.min(maxScroll, this.readerScroll + (ev.name === 'wheel_down' ? 3 : 1));
      }
    } else if (ev.name === 'pageup' || ev.char === 'b') {
      const step = Math.max(4, bodyHeight - 2);
      this.readerScroll = Math.max(0, this.readerScroll - step);
      this.readerCursor = Math.max(0, this.readerCursor - step);
    } else if (ev.name === 'pagedown' || ev.name === 'space') {
      const step = Math.max(4, bodyHeight - 2);
      this.readerScroll = Math.min(maxScroll, this.readerScroll + step);
      this.readerCursor = Math.min(Math.max(0, totalLines - 1), this.readerCursor + step);
    } else if (ev.name === 'home' || ev.char === 'g') {
      this.readerScroll = 0;
      this.readerCursor = 0;
    } else if (ev.name === 'end' || ev.char === 'G') {
      this.readerScroll = maxScroll;
      this.readerCursor = Math.max(0, totalLines - 1);
    }

    this.draw();
  }

  private async copySelectedPath(): Promise<void> {
    const targetPath =
      this.view === 'reader'
        ? (this.activeFilePreview?.filePath ?? this.currentDir)
        : (this.currentEntries[this.selectedIndex]?.fullPath ?? this.currentDir);

    const result = await copyTextToClipboard(targetPath);
    if (result.ok) {
      this.toastMessage = `Caminho copiado: ${stripUnsafeAnsi(targetPath)}`;
    } else {
      this.toastMessage = `Falha ao copiar caminho: ${stripUnsafeAnsi(result.error ?? 'clipboard indisponível')}`;
    }
    this.draw();
  }

  private async reloadDirectory(focusEntryName?: string): Promise<void> {
    const parentDir = path.dirname(this.currentDir);
    const [parentRes, currentRes] = await Promise.all([
      parentDir !== this.currentDir
        ? readDirectoryEntries(parentDir, { showHidden: this.showHidden })
        : Promise.resolve({ dirPath: parentDir, entries: [] }),
      readDirectoryEntries(this.currentDir, { showHidden: this.showHidden, filter: this.filterQuery }),
    ]);

    this.parentEntries = parentRes.entries;
    this.currentEntries = currentRes.entries;

    if (focusEntryName) {
      const idx = this.currentEntries.findIndex((e) => e.name === focusEntryName);
      this.selectedIndex = idx >= 0 ? idx : 0;
    } else {
      this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.currentEntries.length - 1));
    }

    await this.refreshSelectedPreview();
    this.refreshGitHeaderSummary();
  }

  private async refreshSelectedPreview(): Promise<void> {
    const entry = this.currentEntries[this.selectedIndex];
    const theme = getTheme(this.themeName);
    const { width, height } = this.screen.getSize();
    const previewWidth = Math.max(24, Math.floor(width * 0.45) - 4);

    if (!entry) {
      this.previewBadge = 'VAZIO';
      this.previewLines = [`${fg(theme.muted)}${ITALIC}(nenhum item selecionado)${RESET}`];
      return;
    }

    if (entry.isDirectory) {
      const sub = await readDirectoryEntries(entry.fullPath, { showHidden: this.showHidden });
      this.previewBadge = 'DIR';
      this.previewLines = renderDirectoryPreview(entry.fullPath, sub.entries, theme, sub.error);
      return;
    }

    const preview = await safeReadFilePreview(entry.fullPath);
    const doc = renderDocument(preview, {
      width: previewWidth,
      theme,
      maxPreviewLines: Math.max(height + 20, 80),
    });
    this.previewBadge = doc.badge;
    this.previewLines = doc.lines;
  }

  private async openInFullscreenTerminal(filePath: string, viewMode?: ViewMode): Promise<void> {
    const result = await openInFullscreenShell(filePath, {
      themeName: this.themeName,
      viewMode,
    });
    if (result.ok) {
      this.toastMessage = `Aberto em terminal tela cheia: ${stripUnsafeAnsi(path.basename(filePath))}`;
    } else {
      this.toastMessage = `Falha ao abrir tela cheia: ${stripUnsafeAnsi(result.error ?? 'terminal indisponível')}`;
    }
    this.draw();
  }

  private async openFileInReader(filePath: string, initialMode?: ViewMode): Promise<void> {
    this.activeFilePreview = await safeReadFilePreview(filePath);
    this.preferredMode = initialMode;
    this.collapsedJsonPaths.clear();
    this.readerScroll = 0;
    this.readerCursor = 0;
    this.readerSearchQuery = '';
    this.readerSearchMatches = [];
    this.view = 'reader';
    this.rerenderReaderDoc();
  }

  private rerenderReaderDoc(): void {
    if (!this.activeFilePreview) return;
    const { width } = this.screen.getSize();
    const theme = getTheme(this.themeName);
    this.activeDoc = renderDocument(this.activeFilePreview, {
      width: Math.max(30, width - 4),
      theme,
      preferredMode: this.preferredMode,
      collapsedJsonPaths: this.collapsedJsonPaths,
    });
    this.recomputeSearchMatches();
  }

  private recomputeSearchMatches(): void {
    this.readerSearchMatches = [];
    if (!this.readerSearchQuery || !this.activeDoc) return;
    const theme = getTheme(this.themeName);
    this.activeDoc.lines.forEach((line, idx) => {
      if (highlightSearch(line, this.readerSearchQuery, theme.searchBg, theme.searchFg).matches > 0) {
        this.readerSearchMatches.push(idx);
      }
    });
  }

  private jumpToMatch(matchIdx: number): void {
    const lineNum = this.readerSearchMatches[matchIdx];
    if (lineNum === undefined) return;
    const { height } = this.screen.getSize();
    const bodyHeight = Math.max(4, height - 3);
    this.readerCursor = lineNum;
    this.readerScroll = Math.max(0, lineNum - Math.floor(bodyHeight / 3));
  }

  private async openFileInEditor(filePath: string, returnTo: 'browser' | 'reader'): Promise<void> {
    const preview = await safeReadFilePreview(filePath);
    if (preview.error) {
      this.toastMessage = preview.error;
      this.draw();
      return;
    }
    if (preview.isBinary) {
      this.toastMessage = `Edição bloqueada: arquivo binário (${preview.magicLabel}).`;
      this.draw();
      return;
    }
    if (preview.truncated) {
      this.toastMessage = 'Edição bloqueada: arquivo excede o limite seguro de 2 MB.';
      this.draw();
      return;
    }

    this.editorEngine = new VimEngine(preview.text);
    this.editorFilePath = preview.filePath;
    this.editorReturnView = returnTo;
    this.editorViewport = { scrollY: 0, scrollX: 0 };
    this.editorStatusMessage = `"${path.basename(preview.filePath)}" ${this.editorEngine.buffer.lines.length}L`;
    this.editorStatusIsError = false;
    this.editorSavedAny = false;
    this.view = 'editor';
    this.draw();
  }

  private async handleEditorKey(ev: KeyEvent): Promise<void> {
    if (!this.editorEngine) {
      this.view = this.editorReturnView;
      this.draw();
      return;
    }

    const { height } = this.screen.getSize();
    const pageSize = Math.max(4, height - 2);
    this.editorStatusMessage = '';
    this.editorStatusIsError = false;

    const action = this.editorEngine.handleKey(ev, pageSize);
    if (action.message) {
      this.editorStatusMessage = action.message;
      this.editorStatusIsError = Boolean(action.isError);
    }

    if (action.type === 'save' || action.type === 'save-and-quit') {
      try {
        const text = this.editorEngine.buffer.toText();
        const { bytes } = await safeWriteTextFile(this.editorFilePath, text);
        this.editorEngine.buffer.dirty = false;
        this.editorSavedAny = true;
        this.editorStatusMessage = `"${path.basename(this.editorFilePath)}" ${this.editorEngine.buffer.lines.length}L, ${bytes}B salvos`;
        this.editorStatusIsError = false;
        if (action.type === 'save-and-quit') {
          await this.closeEditor();
          return;
        }
      } catch (err) {
        this.editorStatusMessage = `Erro ao salvar: ${err instanceof Error ? err.message : String(err)}`;
        this.editorStatusIsError = true;
      }
    } else if (action.type === 'quit' || action.type === 'force-quit') {
      await this.closeEditor();
      return;
    }

    this.draw();
  }

  private async closeEditor(): Promise<void> {
    const returnTo = this.editorReturnView;
    const savedPath = this.editorFilePath;
    const didSave = this.editorSavedAny;

    this.editorEngine = null;
    this.editorFilePath = '';
    this.editorStatusMessage = '';
    this.editorStatusIsError = false;
    this.view = returnTo;

    if (returnTo === 'reader' && didSave && savedPath) {
      await this.openFileInReader(savedPath);
      this.toastMessage = `Salvo: ${path.basename(savedPath)}`;
    } else if (returnTo === 'browser') {
      if (didSave) {
        await this.reloadDirectory(path.basename(savedPath));
        this.toastMessage = `Salvo: ${path.basename(savedPath)}`;
      } else {
        await this.refreshSelectedPreview();
      }
    }
    this.draw();
  }

  private draw(): void {
    const theme = getTheme(this.themeName);
    const { width, height } = this.screen.getSize();
    const lines =
      this.view === 'editor' && this.editorEngine
        ? buildEditorFrame({
            engine: this.editorEngine,
            filePath: this.editorFilePath,
            width,
            height,
            theme,
            viewport: this.editorViewport,
            statusMessage: this.editorStatusMessage,
            statusIsError: this.editorStatusIsError,
          })
        : this.view === 'git' && this.gitSnapshot
          ? buildGitPanelFrame(
              {
                snapshot: this.gitSnapshot,
                github: this.gitHubData,
                activeTab: this.gitTab,
                selectedIndex: this.gitSelectedIndex,
                listScroll: this.gitListScroll,
                detailTitle: this.gitDetailTitle,
                detailLines: this.gitDetailLines,
                detailScroll: this.gitDetailScroll,
                showQuickPalette: this.gitShowQuickPalette,
                quickPaletteIndex: this.gitQuickPaletteIndex,
                busyMessage: this.gitBusyMessage,
                footerLine: this.buildFooterBar(width, theme),
              },
              width,
              height,
              theme
            )
          : this.view === 'reader'
            ? this.buildReaderFrame(width, height, theme)
            : this.buildBrowserFrame(width, height, theme);

    if (this.showHelp) {
      this.overlayHelpModal(lines, width, height, theme);
    }

    this.screen.render(lines);
  }

  private buildBrowserFrame(width: number, height: number, theme: ThemePalette): string[] {
    const bodyHeight = Math.max(4, height - 2);
    const useThreePanes = width >= 96;
    const useTwoPanes = width >= 60 && !useThreePanes;

    const parentW = useThreePanes ? Math.max(16, Math.floor(width * 0.2)) : 0;
    const currentW = useThreePanes
      ? Math.max(24, Math.floor(width * 0.34))
      : useTwoPanes
        ? Math.max(24, Math.floor(width * 0.44))
        : width;
    const previewW = Math.max(0, width - parentW - currentW - (useThreePanes ? 2 : useTwoPanes ? 1 : 0));

    // Cabeçalho superior
    const brand = `${bg(theme.headerBg)}${fg(theme.accent)}${BOLD} ◈ EXPLOREIO ${RESET}`;
    const gitBadge = formatGitHeaderBadge(this.gitSummary, theme);
    const themePill = `${bg(theme.headerBg)}${fg(theme.muted)} [${theme.label}]${this.showHidden ? ' [.*]' : ''} ${RESET}`;
    const pathMax = Math.max(10, width - visibleLength(brand) - visibleLength(gitBadge) - visibleLength(themePill) - 2);
    const headerPath = `${bg(theme.headerBg)}${fg(theme.headerFg)}${BOLD} ${truncateAnsi(stripUnsafeAnsi(this.currentDir), pathMax)} ${RESET}`;
    const headerFill = `${bg(theme.headerBg)}${' '.repeat(Math.max(0, width - visibleLength(brand) - visibleLength(headerPath) - visibleLength(gitBadge) - visibleLength(themePill)))}${RESET}`;
    const headerLine = `${brand}${headerPath}${headerFill}${gitBadge}${themePill}`;

    // Mantém seleção centralizada/visível no painel atual
    if (this.selectedIndex < this.listScroll) this.listScroll = this.selectedIndex;
    if (this.selectedIndex >= this.listScroll + bodyHeight) {
      this.listScroll = this.selectedIndex - bodyHeight + 1;
    }

    const currentName = path.basename(this.currentDir);
    const parentActiveIdx = this.parentEntries.findIndex((e) => e.name === currentName);
    const parentScroll = Math.max(0, parentActiveIdx - Math.floor(bodyHeight / 2));
    const sep = `${fg(theme.border)}│${RESET}`;

    const rows: string[] = [headerLine];
    for (let r = 0; r < bodyHeight; r++) {
      let rowStr = '';

      if (useThreePanes) {
        const pEntry = this.parentEntries[parentScroll + r];
        let pText = '';
        if (pEntry) {
          const isCur = pEntry.name === currentName;
          const safePName = stripUnsafeAnsi(pEntry.name);
          const prefix = pEntry.isDirectory ? '▸ ' : '· ';
          pText = isCur
            ? `${bg(theme.selectionBg)}${fg(theme.selectionFg)}${BOLD}${fitAnsi(`${prefix}${safePName}`, parentW)}${RESET}`
            : `${fg(pEntry.isDirectory ? theme.dir : theme.muted)}${fitAnsi(`${prefix}${safePName}`, parentW)}${RESET}`;
        } else {
          pText = ' '.repeat(parentW);
        }
        rowStr += `${pText}${sep}`;
      }

      // Painel central (diretório atual)
      const cIdx = this.listScroll + r;
      const cEntry = this.currentEntries[cIdx];
      if (cEntry) {
        const selected = cIdx === this.selectedIndex;
        const sizeLabel = cEntry.isDirectory ? '/' : formatBytes(cEntry.size);
        const badge = getFileBadge(cEntry, theme);
        const nameBudget = Math.max(8, currentW - sizeLabel.length - 5);
        const clippedName = truncateAnsi(stripUnsafeAnsi(cEntry.name), nameBudget);
        if (selected) {
          const inner = ` ▸ ${clippedName}${' '.repeat(Math.max(1, currentW - visibleLength(clippedName) - sizeLabel.length - 4))}${sizeLabel} `;
          rowStr += `${bg(theme.selectionBg)}${fg(theme.selectionFg)}${BOLD}${fitAnsi(inner, currentW)}${RESET}`;
        } else {
          const color = cEntry.isDirectory ? theme.dir : theme.text;
          const left = ` ${badge} ${fg(color)}${clippedName}${RESET}`;
          const pad = ' '.repeat(Math.max(1, currentW - visibleLength(left) - sizeLabel.length - 1));
          rowStr += fitAnsi(`${left}${pad}${fg(theme.muted)}${DIM}${sizeLabel}${RESET} `, currentW);
        }
      } else if (r === 0 && this.currentEntries.length === 0) {
        rowStr += fitAnsi(` ${fg(theme.muted)}${ITALIC}(vazio)${RESET}`, currentW);
      } else {
        rowStr += ' '.repeat(currentW);
      }

      // Painel direito (Preview rico ao vivo)
      if (previewW > 0) {
        const pLine =
          r === 0
            ? `${fg(theme.accentAlt)}${BOLD} Preview${this.previewBadge ? ` · ${this.previewBadge}` : ''}${RESET}`
            : ` ${this.previewLines[r - 1] ?? ''}`;
        rowStr += `${sep}${fitAnsi(pLine, previewW)}`;
      }

      rows.push(rowStr);
    }

    rows.push(this.buildFooterBar(width, theme));
    return rows;
  }

  private buildReaderFrame(width: number, height: number, theme: ThemePalette): string[] {
    const bodyHeight = Math.max(4, height - 2);
    const doc = this.activeDoc;
    const totalLines = doc?.lines.length ?? 0;
    const isJsonTree = doc?.kind === 'json' && doc.activeMode === 'tree';
    const pct = totalLines <= bodyHeight ? '100%' : `${Math.min(100, Math.round(((this.readerScroll + bodyHeight) / totalLines) * 100))}%`;

    const fileName = this.activeFilePreview ? stripUnsafeAnsi(path.basename(this.activeFilePreview.filePath)) : '';
    const left = `${bg(theme.headerBg)}${fg(theme.accent)}${BOLD} ◈ LEITOR ${RESET}${bg(theme.headerBg)}${fg(theme.headerFg)}${BOLD} ${fileName} ${RESET}`;
    const right = `${bg(theme.headerBg)}${fg(theme.accentAlt)}${BOLD}[${doc?.badge ?? 'TEXT'}]${RESET}${bg(theme.headerBg)}${fg(theme.muted)} ${pct} · ${totalLines}L ${RESET}`;
    const fill = `${bg(theme.headerBg)}${' '.repeat(Math.max(0, width - visibleLength(left) - visibleLength(right)))}${RESET}`;

    const rows: string[] = [`${left}${fill}${right}`];

    for (let r = 0; r < bodyHeight; r++) {
      const idx = this.readerScroll + r;
      let line = doc?.lines[idx] ?? '';
      if (this.readerSearchQuery && line) {
        line = highlightSearch(line, this.readerSearchQuery, theme.searchBg, theme.searchFg).text;
      }
      if (isJsonTree && idx === this.readerCursor && idx < totalLines) {
        rows.push(`${bg(theme.selectionBg)}${fg(theme.selectionFg)}${fitAnsi(` ▸ ${line}`, width)}${RESET}`);
      } else {
        rows.push(fitAnsi(`  ${line}`, width));
      }
    }

    rows.push(this.buildFooterBar(width, theme));
    return rows;
  }

  private buildFooterBar(width: number, theme: ThemePalette): string {
    if (this.promptKind) {
      const labels: Record<Exclude<PromptKind, null>, string> = {
        filter: 'Filtrar arquivos: ',
        search: 'Buscar no arquivo: ',
        create: 'Criar arquivo ou pasta/ : ',
        rename: 'Renomear para: ',
        delete: `Excluir "${this.currentEntries[this.selectedIndex]?.name ?? ''}"? (y/N): `,
        'git-commit': 'git commit -m : ',
        'git-branch-create': 'Nova branch (git checkout -b): ',
        'git-confirm': `${this.gitPendingConfirm?.label ?? 'Confirmar operação Git'}? (y/N): `,
      };
      const text = ` ${labels[this.promptKind]}${this.promptInput}█`;
      return `${bg(theme.selectionBg)}${fg(theme.selectionFg)}${BOLD}${fitAnsi(text, width)}${RESET}`;
    }

    if (this.toastMessage) {
      return `${bg(theme.statusBg)}${fg(theme.warning)}${BOLD}${fitAnsi(` ◆ ${this.toastMessage}`, width)}${RESET}`;
    }

    if (this.view === 'reader') {
      const isJsonTree = this.activeDoc?.kind === 'json' && this.activeDoc.activeMode === 'tree';
      const exitLabel = this.singleFile ? 'Esc/q Fechar' : 'Esc Voltar';
      const hint = isJsonTree
        ? ` ${exitLabel} · ↑↓ Navegar · Enter/←→ Nó · e/c Tudo · o Tela cheia · E Vim · Tab Pretty · y Path · / Buscar · t Tema`
        : ` ${exitLabel} · o Tela cheia · e Vim · ↑↓/PgUp/PgDn Rolar · Tab Modo · y Path · / Buscar · t Tema · ? Ajuda`;
      return `${bg(theme.statusBg)}${fg(theme.statusFg)}${fitAnsi(hint, width)}${RESET}`;
    }

    if (this.view === 'git') {
      const hint =
        this.gitTab === 'status'
          ? ' Esc Voltar · 1-4/Tab Abas · ↑↓ Selecionar · J/K Rolar diff · s/Space Stage · S All · c Commit · p Pull · P Push · b Branch · ? Ações'
          : this.gitTab === 'graph'
            ? ' Esc Voltar · 1-4/Tab Abas · ↑↓ Commits · J/K Rolar show · y Copiar hash · p Pull · P Push · f Fetch · r Atualizar · ? Ações'
            : this.gitTab === 'branches'
              ? ' Esc Voltar · 1-4/Tab Abas · ↑↓ Branches · Enter Checkout · b +Branch · p Pull · P Push · f Fetch · ? Ações'
              : ' Esc Voltar · 1-4/Tab Abas · ↑↓ Itens · y/Enter Copiar URL · r Atualizar · t Tema · ? Ações';
      return `${bg(theme.statusBg)}${fg(theme.statusFg)}${fitAnsi(hint, width)}${RESET}`;
    }

    const pos = this.currentEntries.length > 0 ? `${this.selectedIndex + 1}/${this.currentEntries.length}` : '0/0';
    const filterTag = this.filterQuery ? ` [filtro: ${this.filterQuery}]` : '';
    const hint = ` ${pos}${filterTag} · Enter Ler · Tab/Ctrl+G Git · o Tela cheia · e Vim · ←→ Navegar · y Path · / Filtrar · t Tema · ? Ajuda · q Sair`;
    return `${bg(theme.statusBg)}${fg(theme.statusFg)}${fitAnsi(hint, width)}${RESET}`;
  }

  private overlayHelpModal(lines: string[], width: number, height: number, theme: ThemePalette): void {
    const boxW = Math.min(78, width - 4);
    const helpItems = [
      '  NAVEGADOR (3 Painéis estilo Yazi)',
      '  ↑/↓ ou j/k       Mover seleção (roda do mouse suportada)',
      '  Enter ou → / l   Entrar na pasta ou ABRIR ARQUIVO NO LEITOR',
      '  ← / h / Bksp     Subir para diretório pai',
      '  / ou f           Filtrar arquivos (fuzzy)',
      '  .                Mostrar/ocultar arquivos ocultos',
      '  y                Copiar caminho selecionado (arquivo ou pasta)',
      '  a / r / d        Criar / Renomear / Excluir (com confirmação)',
      '  Tab ou Ctrl+G    Abrir PAINEL GIT / GITHUB (status, árvore, branches, PRs)',
      '',
      '  PAINEL GIT / GITHUB (Tab ou Ctrl+G)',
      '  1-4 ou Tab       Alternar abas (Status/Parados · Árvore · Branches · GitHub)',
      '  s / S / c        Stage/Unstage · Stage All · Commit com mensagem',
      '  p / P / f / b    Pull · Push · Fetch · Criar nova branch (? abre paleta)',
      '',
      '  MODO LEITOR FULLSCREEN (Markdown · Mermaid · JSON · HTML · Código)',
      '  Tab              Alternar modo (Rendered↔Raw | Tree↔Pretty | Reader↔Source)',
      '  o ou F           Abrir arquivo em novo terminal TELA CHEIA (ideal p/ split)',
      '  Enter / ← / →    Expandir/recolher nó no JSON Tree (e=tudo, c=recolher)',
      '  /  e  n / N      Buscar texto no arquivo e saltar ocorrências',
      '  y                Copiar caminho completo do arquivo aberto',
      '  e (ou E no JSON) Abrir arquivo no EDITOR VIM NATIVO',
      '  t                Alternar tema (Midnight · Parchment Light · Nord)',
      '  Esc ou q         Voltar ao navegador (ou sair)',
      '',
      '  MODO EDITOR VIM (NORMAL · INSERT · VISUAL · COMMAND)',
      '  i/I/a/A/o/O      Entrar em INSERT (Esc volta para NORMAL)',
      '  hjkl · w/b/e     Navegar · 0/^/$ · gg/G · Ctrl+d/u · / Buscar (n/N)',
      '  x · dd · yy · p  Editar · v/V Visual (y/d/c) · u Undo · Ctrl+r Redo',
      '  :w · :wq · :q!   Salvar · Salvar e sair · Sair sem salvar · :<linha>',
    ];

    const startRow = Math.max(1, Math.floor((height - (helpItems.length + 4)) / 2));
    const padLeft = ' '.repeat(Math.max(0, Math.floor((width - boxW) / 2)));
    const innerW = boxW - 2;

    const modalLines: string[] = [
      `${padLeft}${fg(theme.borderActive)}${BOLD}╭${'─'.repeat(innerW)}╮${RESET}`,
      `${padLeft}${fg(theme.borderActive)}${BOLD}│${bg(theme.headerBg)}${fg(theme.accent)}${fitAnsi('  ◈ EXPLOREIO — ATALHOS DE TECLADO (Esc/? para fechar)', innerW)}${RESET}${fg(theme.borderActive)}${BOLD}│${RESET}`,
      ...helpItems.map(
        (item) =>
          `${padLeft}${fg(theme.borderActive)}│${bg(theme.statusBg)}${fg(item.startsWith('  NAVEGADOR') || item.startsWith('  MODO') ? theme.accentAlt : theme.text)}${fitAnsi(item, innerW)}${RESET}${fg(theme.borderActive)}│${RESET}`
      ),
      `${padLeft}${fg(theme.borderActive)}${BOLD}╰${'─'.repeat(innerW)}╯${RESET}`,
    ];

    modalLines.forEach((mLine, offset) => {
      const targetRow = startRow + offset;
      if (targetRow >= 0 && targetRow < lines.length) {
        lines[targetRow] = mLine;
      }
    });
  }

  // ==================== PAINEL GIT & GITHUB (SPEC-005) ====================

  private refreshGitHeaderSummary(): void {
    const seq = ++this.gitSummarySeq;
    const targetDir = this.currentDir;
    void getGitSummaryBadge(targetDir).then((summary) => {
      if (seq !== this.gitSummarySeq) return;
      this.gitSummary = summary;
      if (this.running && this.view === 'browser') {
        this.draw();
      }
    });
  }

  private async openGitPanel(): Promise<void> {
    this.view = 'git';
    this.gitShowQuickPalette = false;
    this.gitQuickPaletteIndex = 0;
    this.gitTab = 'status';
    this.gitSelectedIndex = 0;
    this.gitListScroll = 0;
    this.gitDetailScroll = 0;
    this.gitBusyMessage = 'Carregando repositório Git...';
    this.toastMessage = '';
    await this.refreshGitPanelData(true);
  }

  private async refreshGitPanelData(reloadGitHub = false): Promise<void> {
    this.gitBusyMessage = 'Atualizando Git...';
    if (this.gitSnapshot) this.draw();

    const snap = await loadGitPanelSnapshot(this.currentDir);
    this.gitSnapshot = snap;
    this.gitBusyMessage = '';

    if (snap.isGitRepo) {
      this.gitSummary = {
        repoRoot: snap.repoRoot,
        branch: snap.status.branch,
        upstream: snap.status.upstream,
        ahead: snap.status.ahead,
        behind: snap.status.behind,
        stagedCount: snap.status.stagedCount,
        unstagedCount: snap.status.unstagedCount,
        untrackedCount: snap.status.untrackedCount,
        dirtyCount:
          snap.status.stagedCount +
          snap.status.unstagedCount +
          snap.status.untrackedCount +
          snap.status.conflictedCount,
      };
    }

    this.clampGitSelection(1);
    await this.refreshGitDetail();
    this.draw();

    if (reloadGitHub && snap.isGitRepo) {
      this.gitHubData = {
        available: false,
        loading: true,
        repoSlug: snap.githubRepo,
        pullRequests: [],
        issues: [],
        workflowRuns: [],
      };
      if (this.gitTab === 'github') this.draw();
      void loadGitHubData(snap.repoRoot, snap.githubRepo).then((ghData) => {
        this.gitHubData = ghData;
        if (this.running && this.view === 'git') {
          if (this.gitTab === 'github') {
            this.clampGitSelection(1);
            void this.refreshGitDetail().then(() => this.draw());
          } else {
            this.draw();
          }
        }
      });
    }
  }

  private getGitTabListLength(): number {
    if (!this.gitSnapshot || !this.gitSnapshot.isGitRepo) return 0;
    if (this.gitTab === 'status') return buildStatusListItems(this.gitSnapshot).length;
    if (this.gitTab === 'graph') return this.gitSnapshot.commitGraph.length;
    if (this.gitTab === 'branches') return this.gitSnapshot.branches.length;
    return buildGitHubListItems(this.gitHubData).length;
  }

  private isGitRowSelectable(index: number): boolean {
    if (!this.gitSnapshot || !this.gitSnapshot.isGitRepo) return false;
    if (this.gitTab === 'status') {
      const item = buildStatusListItems(this.gitSnapshot)[index];
      return Boolean(item && item.kind !== 'header');
    }
    if (this.gitTab === 'graph') {
      const row = this.gitSnapshot.commitGraph[index];
      return Boolean(row && !row.isConnectorOnly);
    }
    if (this.gitTab === 'branches') {
      return Boolean(this.gitSnapshot.branches[index]);
    }
    const ghItem = buildGitHubListItems(this.gitHubData)[index];
    return Boolean(ghItem && ghItem.kind !== 'header');
  }

  private clampGitSelection(direction: 1 | -1 = 1): void {
    const len = this.getGitTabListLength();
    if (len === 0) {
      this.gitSelectedIndex = 0;
      this.gitListScroll = 0;
      return;
    }

    let idx = Math.max(0, Math.min(len - 1, this.gitSelectedIndex));
    if (!this.isGitRowSelectable(idx)) {
      let found = -1;
      for (let i = idx; i >= 0 && i < len; i += direction) {
        if (this.isGitRowSelectable(i)) {
          found = i;
          break;
        }
      }
      if (found === -1) {
        for (let i = idx; i >= 0 && i < len; i -= direction) {
          if (this.isGitRowSelectable(i)) {
            found = i;
            break;
          }
        }
      }
      idx = found >= 0 ? found : 0;
    }

    this.gitSelectedIndex = idx;
    const { height } = this.screen.getSize();
    const bodyHeight = Math.max(4, height - 3);
    if (this.gitSelectedIndex < this.gitListScroll) {
      this.gitListScroll = this.gitSelectedIndex;
    } else if (this.gitSelectedIndex >= this.gitListScroll + bodyHeight) {
      this.gitListScroll = this.gitSelectedIndex - bodyHeight + 1;
    }
  }

  private moveGitSelection(delta: number): void {
    const len = this.getGitTabListLength();
    if (len === 0) return;
    const dir: 1 | -1 = delta >= 0 ? 1 : -1;
    let next = this.gitSelectedIndex + delta;
    while (next >= 0 && next < len && !this.isGitRowSelectable(next)) {
      next += dir;
    }
    if (next >= 0 && next < len && this.isGitRowSelectable(next)) {
      this.gitSelectedIndex = next;
    }
    this.clampGitSelection(dir);
  }

  private async refreshGitDetail(): Promise<void> {
    this.gitDetailScroll = 0;
    const snap = this.gitSnapshot;
    if (!snap || !snap.isGitRepo) {
      this.gitDetailTitle = 'Git';
      this.gitDetailLines = [];
      return;
    }

    if (this.gitTab === 'status') {
      const item = buildStatusListItems(snap)[this.gitSelectedIndex];
      if (!item || item.kind === 'header') {
        this.gitDetailTitle = `Resumo · ${snap.githubRepo ?? snap.repoName}`;
        this.gitDetailLines = [
          `Branch: ${snap.status.branch}`,
          `Upstream: ${snap.status.upstream ?? '(nenhum — use P para publicar)'}`,
          `Commits parados (ahead): ${snap.unpushedCommits.length}`,
          `Commits atrás (behind): ${snap.status.behind}`,
          `Staged: ${snap.status.stagedCount} | Modificados: ${snap.status.unstagedCount} | Untracked: ${snap.status.untrackedCount}`,
          `Stashes: ${snap.stashCount}`,
          snap.remoteUrl ? `Remote: ${snap.remoteUrl}` : 'Remote: (nenhum)',
          '',
          'Dica: pressione `?` para abrir a Paleta de Comandos Rápidos.',
        ];
        return;
      }
      if (item.kind === 'unpushed') {
        this.gitDetailTitle = `Commit Parado ↑ ${item.commit.shortHash}`;
        this.gitDetailLines = await loadCommitDetails(snap.repoRoot, item.commit.fullHash || item.commit.shortHash);
        return;
      }
      const sectionLabel =
        item.entry.section === 'staged'
          ? 'STAGED'
          : item.entry.section === 'untracked'
            ? 'NOVO'
            : 'DIFF';
      this.gitDetailTitle = `${sectionLabel} · ${item.entry.path}`;
      this.gitDetailLines = await loadFileDiff(snap.repoRoot, item.entry);
      return;
    }

    if (this.gitTab === 'graph') {
      const row = snap.commitGraph[this.gitSelectedIndex];
      if (!row || row.isConnectorOnly) {
        this.gitDetailTitle = 'Árvore de Commits';
        this.gitDetailLines = ['Selecione um commit para inspecionar o diff completo.'];
        return;
      }
      this.gitDetailTitle = `Commit ${row.shortHash}${row.isUnpushed ? ' (↑ parado)' : ''}`;
      this.gitDetailLines = await loadCommitDetails(snap.repoRoot, row.fullHash || row.shortHash);
      return;
    }

    if (this.gitTab === 'branches') {
      const br = snap.branches[this.gitSelectedIndex];
      if (!br) {
        this.gitDetailTitle = 'Branches';
        this.gitDetailLines = [];
        return;
      }
      this.gitDetailTitle = `Branch · ${br.name}`;
      this.gitDetailLines = [
        `Branch: ${br.name}${br.isCurrent ? ' (ATIVA)' : ''}`,
        `Tipo: ${br.isRemote ? 'Remota' : 'Local'}`,
        `Upstream: ${br.upstream || '(não configurado)'}`,
        `Status: ${br.track || 'sincronizada'}`,
        `Última atividade: ${br.relativeDate}`,
        `Último commit: ${br.subject}`,
        '',
        'Atalhos nesta aba:',
        '  Enter  -> git checkout <branch> (com confirmação)',
        '  b      -> git checkout -b <nova-branch>',
        '  p / P  -> git pull / git push',
        '  ?      -> Paleta de comandos rápidos',
      ];
      return;
    }

    const ghItem = buildGitHubListItems(this.gitHubData)[this.gitSelectedIndex];
    if (!ghItem || ghItem.kind === 'header') {
      this.gitDetailTitle = `GitHub · ${this.gitHubData.repoSlug ?? ''}`;
      this.gitDetailLines = this.gitHubData.available
        ? [
            `Repositório: ${this.gitHubData.repoSlug}`,
            `Pull Requests abertos: ${this.gitHubData.pullRequests.length}`,
            `Issues abertas: ${this.gitHubData.issues.length}`,
            `Workflow Runs recentes: ${this.gitHubData.workflowRuns.length}`,
          ]
        : [this.gitHubData.reason ?? 'GitHub indisponível.'];
      return;
    }
    if (ghItem.kind === 'pr') {
      const pr = ghItem.pr;
      this.gitDetailTitle = `PR #${pr.number}`;
      this.gitDetailLines = [
        `#${pr.number} — ${pr.title}`,
        `Autor: @${pr.author}`,
        `Branches: ${pr.headRefName} → ${pr.baseRefName}`,
        `Status: ${pr.isDraft ? 'Draft' : 'Open'}${pr.reviewDecision ? ` · Review: ${pr.reviewDecision}` : ''}`,
        `Atualizado: ${pr.updatedAt}`,
        `URL: ${pr.url}`,
        '',
        'Pressione Enter ou y para copiar a URL do PR.',
      ];
      return;
    }
    if (ghItem.kind === 'issue') {
      const issue = ghItem.issue;
      this.gitDetailTitle = `Issue #${issue.number}`;
      this.gitDetailLines = [
        `#${issue.number} — ${issue.title}`,
        `Autor: @${issue.author}`,
        `Labels: ${issue.labels.length > 0 ? issue.labels.join(', ') : '(nenhuma)'}`,
        `Atualizado: ${issue.updatedAt}`,
        `URL: ${issue.url}`,
        '',
        'Pressione Enter ou y para copiar a URL da Issue.',
      ];
      return;
    }
    const run = ghItem.run;
    this.gitDetailTitle = `Action · ${run.workflowName}`;
    this.gitDetailLines = [
      `Workflow: ${run.workflowName}`,
      `Título: ${run.title}`,
      `Branch: ${run.branch}`,
      `Status: ${run.status} · Conclusão: ${run.conclusion || 'em andamento'}`,
      `Atualizado: ${run.updatedAt}`,
      `URL: ${run.url}`,
      '',
      'Pressione Enter ou y para copiar a URL do Workflow Run.',
    ];
  }

  private async handleGitKey(ev: KeyEvent): Promise<void> {
    this.toastMessage = '';

    // Paleta interativa de comandos rápidos (`?`)
    if (this.gitShowQuickPalette && this.gitSnapshot) {
      const actions = buildQuickActions(this.gitSnapshot);
      if (ev.name === 'escape' || ev.char === '?' || ev.char === 'q') {
        this.gitShowQuickPalette = false;
        this.draw();
        return;
      }
      if (ev.name === 'up' || ev.char === 'k') {
        this.gitQuickPaletteIndex = (this.gitQuickPaletteIndex - 1 + actions.length) % actions.length;
        this.draw();
        return;
      }
      if (ev.name === 'down' || ev.char === 'j') {
        this.gitQuickPaletteIndex = (this.gitQuickPaletteIndex + 1) % actions.length;
        this.draw();
        return;
      }
      if (ev.name === 'enter') {
        const chosen = actions[this.gitQuickPaletteIndex];
        this.gitShowQuickPalette = false;
        if (chosen) await this.triggerGitQuickAction(chosen.id);
        this.draw();
        return;
      }
      if (ev.char && ev.char >= '1' && ev.char <= '9') {
        const chosen = actions.find((a) => a.hotkey === ev.char);
        this.gitShowQuickPalette = false;
        if (chosen) await this.triggerGitQuickAction(chosen.id);
        this.draw();
        return;
      }
      return;
    }

    if (ev.name === 'escape' || ev.char === 'q') {
      this.view = 'browser';
      await this.reloadDirectory();
      this.draw();
      return;
    }
    if (ev.char === 't') {
      this.themeName = nextTheme(this.themeName);
      this.toastMessage = `Tema ativo: ${getTheme(this.themeName).label}`;
      this.draw();
      return;
    }
    if (ev.char === '?' && this.gitSnapshot?.isGitRepo) {
      this.gitShowQuickPalette = true;
      this.gitQuickPaletteIndex = 0;
      this.draw();
      return;
    }
    if (!this.gitSnapshot?.isGitRepo) {
      this.draw();
      return;
    }

    // Troca de abas (1..4 ou Tab / Shift+Tab)
    const tabOrder: readonly GitPanelTab[] = ['status', 'graph', 'branches', 'github'];
    if (ev.char === '1' || ev.char === '2' || ev.char === '3' || ev.char === '4') {
      const nextTab = tabOrder[Number(ev.char) - 1] ?? 'status';
      if (nextTab !== this.gitTab) {
        this.gitTab = nextTab;
        this.gitSelectedIndex = 0;
        this.gitListScroll = 0;
        this.clampGitSelection(1);
        await this.refreshGitDetail();
      }
      this.draw();
      return;
    }
    if (ev.name === 'tab') {
      const idx = tabOrder.indexOf(this.gitTab);
      const nextIdx = ev.shift ? (idx - 1 + tabOrder.length) % tabOrder.length : (idx + 1) % tabOrder.length;
      this.gitTab = tabOrder[nextIdx] ?? 'status';
      this.gitSelectedIndex = 0;
      this.gitListScroll = 0;
      this.clampGitSelection(1);
      await this.refreshGitDetail();
      this.draw();
      return;
    }

    // Navegação na lista
    if (ev.name === 'up' || ev.char === 'k' || ev.name === 'wheel_up') {
      this.moveGitSelection(-1);
      await this.refreshGitDetail();
      this.draw();
      return;
    }
    if (ev.name === 'down' || ev.char === 'j' || ev.name === 'wheel_down') {
      this.moveGitSelection(1);
      await this.refreshGitDetail();
      this.draw();
      return;
    }
    // Rolagem do painel direito (diff / detalhes)
    if (ev.char === 'J' || ev.name === 'pagedown') {
      this.gitDetailScroll = Math.min(Math.max(0, this.gitDetailLines.length - 5), this.gitDetailScroll + 8);
      this.draw();
      return;
    }
    if (ev.char === 'K' || ev.name === 'pageup') {
      this.gitDetailScroll = Math.max(0, this.gitDetailScroll - 8);
      this.draw();
      return;
    }

    // Ações rápidas diretas
    if (ev.char === 'r') {
      await this.refreshGitPanelData(true);
      this.toastMessage = 'Painel Git/GitHub atualizado.';
      this.draw();
      return;
    }
    if (ev.char === 'f') {
      await this.triggerGitQuickAction('fetch');
      return;
    }
    if (ev.char === 'p') {
      await this.triggerGitQuickAction('pull');
      return;
    }
    if (ev.char === 'P') {
      await this.triggerGitQuickAction('push');
      return;
    }
    if (ev.char === 'c') {
      await this.triggerGitQuickAction('commit');
      return;
    }
    if (ev.char === 'b') {
      await this.triggerGitQuickAction('create-branch');
      return;
    }
    if (ev.char === 'S') {
      await this.triggerGitQuickAction('stage-all');
      return;
    }
    if (ev.char === 'U') {
      const res = await gitUnstageAll(this.gitSnapshot.repoRoot);
      this.toastMessage = res.ok ? 'Todas as alterações removidas do stage.' : (res.errorMessage ?? 'Erro no unstage.');
      await this.refreshGitPanelData(false);
      return;
    }

    // Stage / Unstage individual na aba Status
    if ((ev.char === 's' || ev.name === 'space') && this.gitTab === 'status') {
      const item = buildStatusListItems(this.gitSnapshot)[this.gitSelectedIndex];
      if (item?.kind === 'file') {
        const res =
          item.entry.section === 'staged'
            ? await gitUnstageFile(this.gitSnapshot.repoRoot, item.entry.path)
            : await gitStageFile(this.gitSnapshot.repoRoot, item.entry.path);
        this.toastMessage = res.ok
          ? `${item.entry.section === 'staged' ? 'Unstaged' : 'Staged'}: ${item.entry.path}`
          : (res.errorMessage ?? 'Erro ao alterar stage.');
        await this.refreshGitPanelData(false);
      }
      return;
    }

    // Descartar alterações de um arquivo (com confirmação obrigatória)
    if (ev.char === 'x' && this.gitTab === 'status') {
      const item = buildStatusListItems(this.gitSnapshot)[this.gitSelectedIndex];
      if (item?.kind === 'file' && item.entry.section !== 'staged') {
        const entry = item.entry;
        const repoRoot = this.gitSnapshot.repoRoot;
        this.askGitConfirm(`Descartar alterações de "${entry.path}"`, async () => {
          const res = await gitDiscardFile(repoRoot, entry);
          this.toastMessage = res.ok ? `Descartado: ${entry.path}` : (res.errorMessage ?? 'Erro ao descartar.');
          await this.refreshGitPanelData(false);
        });
      }
      return;
    }

    // Copiar hash / path / branch / URL
    if (ev.char === 'y') {
      await this.copyActiveGitItem();
      return;
    }

    // Enter contextual por aba
    if (ev.name === 'enter') {
      if (this.gitTab === 'branches') {
        const br = this.gitSnapshot.branches[this.gitSelectedIndex];
        if (br && !br.isCurrent) {
          const repoRoot = this.gitSnapshot.repoRoot;
          this.askGitConfirm(`Trocar para branch "${br.name}" (git checkout)`, async () => {
            const res = await gitCheckoutBranch(repoRoot, br.name);
            this.toastMessage = res.ok ? `Branch ativa: ${br.name}` : (res.errorMessage ?? 'Erro no checkout.');
            await this.refreshGitPanelData(false);
          });
        }
        return;
      }
      if (this.gitTab === 'status') {
        const item = buildStatusListItems(this.gitSnapshot)[this.gitSelectedIndex];
        if (item?.kind === 'file') {
          const fullPath = path.resolve(this.gitSnapshot.repoRoot, item.entry.path);
          await this.openFileInReader(fullPath);
          this.draw();
        }
        return;
      }
      if (this.gitTab === 'github') {
        await this.copyActiveGitItem();
      }
    }
  }

  private askGitConfirm(label: string, run: () => Promise<void>): void {
    this.gitPendingConfirm = { label, run };
    this.promptKind = 'git-confirm';
    this.promptInput = '';
    this.draw();
  }

  private async triggerGitQuickAction(actionId: GitQuickActionId): Promise<void> {
    const snap = this.gitSnapshot;
    if (!snap || !snap.isGitRepo) return;
    const repoRoot = snap.repoRoot;

    switch (actionId) {
      case 'pull':
        this.askGitConfirm(`Executar git pull --ff-only em "${snap.status.branch}"`, async () => {
          this.gitBusyMessage = 'Executando git pull...';
          this.draw();
          const res = await gitPull(repoRoot);
          this.gitBusyMessage = '';
          this.toastMessage = res.ok ? 'git pull concluído com sucesso.' : (res.errorMessage ?? 'Erro no git pull.');
          await this.refreshGitPanelData(true);
        });
        return;
      case 'push': {
        const noUpstream = !snap.status.upstream ? snap.status.branch : undefined;
        const cmdLabel = noUpstream ? `git push -u origin ${noUpstream}` : 'git push';
        this.askGitConfirm(`Executar ${cmdLabel}`, async () => {
          this.gitBusyMessage = `Executando ${cmdLabel}...`;
          this.draw();
          const res = await gitPush(repoRoot, noUpstream);
          this.gitBusyMessage = '';
          this.toastMessage = res.ok ? `${cmdLabel} concluído.` : (res.errorMessage ?? 'Erro no git push.');
          await this.refreshGitPanelData(true);
        });
        return;
      }
      case 'fetch':
        this.gitBusyMessage = 'Executando git fetch --all --prune...';
        this.draw();
        {
          const res = await gitFetch(repoRoot);
          this.gitBusyMessage = '';
          this.toastMessage = res.ok ? 'git fetch concluído.' : (res.errorMessage ?? 'Erro no git fetch.');
          await this.refreshGitPanelData(true);
        }
        return;
      case 'commit':
        if (snap.status.stagedCount === 0) {
          this.toastMessage = 'Nenhum arquivo em stage. Use `s` ou `S` (Stage All) antes de commitar.';
          this.draw();
          return;
        }
        this.promptKind = 'git-commit';
        this.promptInput = '';
        this.draw();
        return;
      case 'create-branch':
        this.promptKind = 'git-branch-create';
        this.promptInput = '';
        this.draw();
        return;
      case 'goto-branches':
        this.gitTab = 'branches';
        this.gitSelectedIndex = 0;
        this.gitListScroll = 0;
        this.clampGitSelection(1);
        await this.refreshGitDetail();
        this.draw();
        return;
      case 'stage-all': {
        const res = await gitStageAll(repoRoot);
        this.toastMessage = res.ok ? 'Todas as alterações adicionadas ao stage (git add -A).' : (res.errorMessage ?? 'Erro no stage.');
        await this.refreshGitPanelData(false);
        return;
      }
      case 'stash-push':
        this.askGitConfirm('Guardar alterações atuais com git stash push -u', async () => {
          const res = await gitStashPush(repoRoot);
          this.toastMessage = res.ok ? 'Alterações salvas no stash.' : (res.errorMessage ?? 'Erro no stash.');
          await this.refreshGitPanelData(false);
        });
        return;
      case 'stash-pop':
        this.askGitConfirm('Restaurar último stash (git stash pop)', async () => {
          const res = await gitStashPop(repoRoot);
          this.toastMessage = res.ok ? 'Último stash restaurado.' : (res.errorMessage ?? 'Erro no stash pop.');
          await this.refreshGitPanelData(false);
        });
    }
  }

  private async executeGitCommitPrompt(message: string): Promise<void> {
    if (!this.gitSnapshot?.isGitRepo) return;
    const clean = message.trim();
    if (!clean) {
      this.toastMessage = 'Commit cancelado (mensagem vazia).';
      return;
    }
    const res = await gitCommit(this.gitSnapshot.repoRoot, clean);
    this.toastMessage = res.ok ? `Commit criado: ${clean}` : (res.errorMessage ?? 'Erro ao criar commit.');
    await this.refreshGitPanelData(false);
  }

  private async executeGitCreateBranchPrompt(branchName: string): Promise<void> {
    if (!this.gitSnapshot?.isGitRepo) return;
    const clean = branchName.trim();
    if (!clean) {
      this.toastMessage = 'Criação de branch cancelada.';
      return;
    }
    const res = await gitCreateBranch(this.gitSnapshot.repoRoot, clean);
    this.toastMessage = res.ok ? `Branch criada e ativada: ${clean}` : (res.errorMessage ?? 'Erro ao criar branch.');
    await this.refreshGitPanelData(false);
  }

  private async copyActiveGitItem(): Promise<void> {
    const snap = this.gitSnapshot;
    if (!snap || !snap.isGitRepo) return;
    let value = '';
    if (this.gitTab === 'status') {
      const item = buildStatusListItems(snap)[this.gitSelectedIndex];
      if (item?.kind === 'unpushed') value = item.commit.shortHash;
      else if (item?.kind === 'file') value = path.resolve(snap.repoRoot, item.entry.path);
    } else if (this.gitTab === 'graph') {
      value = snap.commitGraph[this.gitSelectedIndex]?.shortHash ?? '';
    } else if (this.gitTab === 'branches') {
      value = snap.branches[this.gitSelectedIndex]?.name ?? '';
    } else {
      const item = buildGitHubListItems(this.gitHubData)[this.gitSelectedIndex];
      if (item?.kind === 'pr') value = item.pr.url;
      else if (item?.kind === 'issue') value = item.issue.url;
      else if (item?.kind === 'run') value = item.run.url;
    }
    if (!value) return;
    const res = await copyTextToClipboard(value);
    this.toastMessage = res.ok
      ? `Copiado: ${stripUnsafeAnsi(value)}`
      : `Falha ao copiar: ${stripUnsafeAnsi(res.error ?? 'clipboard indisponível')}`;
    this.draw();
  }
}

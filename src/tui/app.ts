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

type AppView = 'browser' | 'reader' | 'editor';
type PromptKind = null | 'filter' | 'search' | 'create' | 'rename' | 'delete';

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
    const themePill = `${bg(theme.headerBg)}${fg(theme.muted)} [${theme.label}]${this.showHidden ? ' [.*]' : ''} ${RESET}`;
    const pathMax = Math.max(10, width - visibleLength(brand) - visibleLength(themePill) - 2);
    const headerPath = `${bg(theme.headerBg)}${fg(theme.headerFg)}${BOLD} ${truncateAnsi(stripUnsafeAnsi(this.currentDir), pathMax)} ${RESET}`;
    const headerFill = `${bg(theme.headerBg)}${' '.repeat(Math.max(0, width - visibleLength(brand) - visibleLength(headerPath) - visibleLength(themePill)))}${RESET}`;
    const headerLine = `${brand}${headerPath}${headerFill}${themePill}`;

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

    const pos = this.currentEntries.length > 0 ? `${this.selectedIndex + 1}/${this.currentEntries.length}` : '0/0';
    const filterTag = this.filterQuery ? ` [filtro: ${this.filterQuery}]` : '';
    const hint = ` ${pos}${filterTag} · Enter Ler · o Tela cheia · e Vim · ←→ Navegar · y Path · / Filtrar · t Tema · ? Ajuda · q Sair`;
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
}

/**
 * Unified Document Renderer Router (SPEC-001)
 * Seleciona automaticamente o renderizador ideal por extensão/conteúdo:
 * Markdown, JSON (Tree + Pretty), HTML (Reader + Source), Código, Texto ou Binário Hex.
 */

import path from 'node:path';
import { formatBytes, type FileEntry, type SafeFilePreview } from '../fs/explorer.js';
import { fg, type ThemePalette } from '../themes/palette.js';
import { BOLD, DIM, ITALIC, RESET, stripUnsafeAnsi } from '../tui/ansi.js';
import { detectLanguageFromPath, renderCodeLines } from './code.js';
import { renderHtmlDocument } from './html.js';
import { renderJsonDocument, type JsonTreeRow } from './json.js';
import { renderMarkdown } from './markdown.js';

export type DocumentKind = 'markdown' | 'json' | 'html' | 'code' | 'text' | 'binary';

export type ViewMode = 'rendered' | 'raw' | 'tree' | 'pretty' | 'reader' | 'source' | 'code' | 'hex';

export interface RenderedDocument {
  readonly kind: DocumentKind;
  readonly modes: readonly ViewMode[];
  readonly activeMode: ViewMode;
  readonly lines: string[];
  readonly jsonTreeRows: JsonTreeRow[];
  readonly badge: string;
}

export function detectDocumentKind(filePath: string, isBinary: boolean): DocumentKind {
  if (isBinary) return 'binary';
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.md' || ext === '.mdx' || ext === '.markdown') return 'markdown';
  if (ext === '.json' || ext === '.jsonc') return 'json';
  if (ext === '.html' || ext === '.htm' || ext === '.xhtml') return 'html';
  const lang = detectLanguageFromPath(filePath);
  if (lang !== 'plain') return 'code';
  return 'text';
}

export function getModesForKind(kind: DocumentKind): readonly ViewMode[] {
  switch (kind) {
    case 'markdown':
      return ['rendered', 'raw'];
    case 'json':
      return ['tree', 'pretty'];
    case 'html':
      return ['reader', 'source'];
    case 'code':
    case 'text':
      return ['code'];
    case 'binary':
      return ['hex'];
  }
}

export function renderBinaryHex(preview: SafeFilePreview, theme: ThemePalette): string[] {
  const out: string[] = [
    `${fg(theme.accent)}${BOLD}◈ Arquivo Binário${RESET}`,
    `${fg(theme.muted)}Tipo detectado:${RESET} ${fg(theme.text)}${BOLD}${preview.magicLabel}${RESET}`,
    `${fg(theme.muted)}Tamanho total :${RESET} ${fg(theme.syntaxNumber)}${formatBytes(preview.size)}${RESET}`,
    `${fg(theme.border)}${'─'.repeat(58)}${RESET}`,
    `${fg(theme.muted)}${DIM}Prévia Hexadecimal (primeiros ${preview.rawHead.length} bytes):${RESET}`,
    '',
  ];

  const bytes = preview.rawHead;
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const addr = offset.toString(16).padStart(6, '0');
    const hexParts: string[] = [];
    let ascii = '';

    for (let j = 0; j < 16; j++) {
      const idx = offset + j;
      if (idx < bytes.length) {
        const b = bytes[idx] ?? 0;
        hexParts.push(b.toString(16).padStart(2, '0'));
        ascii += b >= 32 && b <= 126 ? String.fromCharCode(b) : '·';
      } else {
        hexParts.push('  ');
        ascii += ' ';
      }
    }

    const leftHex = hexParts.slice(0, 8).join(' ');
    const rightHex = hexParts.slice(8).join(' ');
    out.push(
      `${fg(theme.muted)}${DIM}${addr}${RESET}  ${fg(theme.accent)}${leftHex}  ${rightHex}${RESET}  ${fg(theme.syntaxString)}│${ascii}│${RESET}`
    );
  }

  return out;
}

export function renderDirectoryPreview(
  dirPath: string,
  entries: readonly FileEntry[],
  theme: ThemePalette,
  error?: string
): string[] {
  if (error) {
    return [`${fg(theme.danger)}${BOLD}▲ ${error}${RESET}`];
  }
  const dirs = entries.filter((e) => e.isDirectory).length;
  const files = entries.length - dirs;
  const out: string[] = [
    `${fg(theme.dir)}${BOLD}▸ ${path.basename(dirPath) || dirPath}${RESET}`,
    `${fg(theme.muted)}${dirs} pasta(s) · ${files} arquivo(s)${RESET}`,
    `${fg(theme.border)}${'─'.repeat(36)}${RESET}`,
  ];

  if (entries.length === 0) {
    out.push(`${fg(theme.muted)}${ITALIC}(diretório vazio)${RESET}`);
    return out;
  }

  for (const entry of entries.slice(0, 60)) {
    const safeName = stripUnsafeAnsi(entry.name);
    const icon = entry.isDirectory ? `${fg(theme.dir)}${BOLD}▸${RESET}` : `${fg(theme.muted)}·${RESET}`;
    const name = entry.isDirectory
      ? `${fg(theme.dir)}${BOLD}${safeName}/${RESET}`
      : `${fg(theme.text)}${safeName}${RESET}`;
    const size = entry.isDirectory ? '' : ` ${fg(theme.muted)}${DIM}(${formatBytes(entry.size)})${RESET}`;
    out.push(`${icon} ${name}${size}`);
  }

  if (entries.length > 60) {
    out.push(`${fg(theme.muted)}${ITALIC}… (+${entries.length - 60} itens)${RESET}`);
  }

  return out;
}

export interface RenderDocumentOptions {
  readonly width: number;
  readonly theme: ThemePalette;
  readonly preferredMode?: ViewMode;
  readonly collapsedJsonPaths?: ReadonlySet<string>;
  readonly maxPreviewLines?: number;
}

export function renderDocument(preview: SafeFilePreview, options: RenderDocumentOptions): RenderedDocument {
  const { width, theme, preferredMode, collapsedJsonPaths, maxPreviewLines } = options;

  if (preview.error) {
    return {
      kind: 'text',
      modes: ['code'],
      activeMode: 'code',
      lines: [`${fg(theme.danger)}${BOLD}▲ ${preview.error}${RESET}`],
      jsonTreeRows: [],
      badge: 'ERROR',
    };
  }

  const kind = detectDocumentKind(preview.filePath, preview.isBinary);
  const modes = getModesForKind(kind);
  const activeMode: ViewMode =
    preferredMode && modes.includes(preferredMode) ? preferredMode : (modes[0] ?? 'code');

  const banner: string[] = preview.truncated
    ? [
        `${fg(theme.warning)}${BOLD}▲ Arquivo truncado nos primeiros 2 MB (${formatBytes(preview.size)} total)${RESET}`,
        '',
      ]
    : [];

  let lines: string[] = [];
  let jsonTreeRows: JsonTreeRow[] = [];
  let badge = kind.toUpperCase();

  if (kind === 'binary') {
    lines = renderBinaryHex(preview, theme);
    badge = preview.magicLabel.toUpperCase();
  } else if (kind === 'markdown') {
    lines = renderMarkdown(preview.text, width, theme, activeMode === 'raw' ? 'raw' : 'rendered');
    badge = activeMode === 'raw' ? 'MD · RAW' : 'MD · RENDERED';
  } else if (kind === 'json') {
    const res = renderJsonDocument(
      preview.text,
      theme,
      activeMode === 'pretty' ? 'pretty' : 'tree',
      collapsedJsonPaths ?? new Set()
    );
    lines = res.lines;
    jsonTreeRows = res.treeRows;
    badge = res.valid ? (activeMode === 'pretty' ? 'JSON · PRETTY' : 'JSON · TREE') : 'JSON · INVALID';
  } else if (kind === 'html') {
    lines = renderHtmlDocument(preview.text, width, theme, activeMode === 'source' ? 'source' : 'reader');
    badge = activeMode === 'source' ? 'HTML · SOURCE' : 'HTML · READER';
  } else {
    const lang = detectLanguageFromPath(preview.filePath);
    lines = renderCodeLines(preview.text, {
      language: lang,
      theme,
      showLineNumbers: true,
      maxLines: maxPreviewLines,
    });
    badge = lang === 'plain' ? 'TEXT' : lang.toUpperCase();
  }

  const finalLines = [...banner, ...lines];
  return {
    kind,
    modes,
    activeMode,
    lines: maxPreviewLines ? finalLines.slice(0, maxPreviewLines) : finalLines,
    jsonTreeRows,
    badge,
  };
}

/**
 * Interactive JSON Tree & Pretty Syntax Renderer (SPEC-001)
 * Suporta Árvore Interativa recolhível/expansível por JSONPath (`$.a.b`),
 * Pretty Highlighted com números de linha e diagnóstico amigável de JSON inválido.
 */

import { fg, type ThemePalette } from '../themes/palette.js';
import { BOLD, DIM, ITALIC, RESET, stripUnsafeAnsi } from '../tui/ansi.js';
import { renderCodeLines } from './code.js';

export interface JsonTreeRow {
  readonly path: string;
  readonly depth: number;
  readonly collapsible: boolean;
  readonly collapsed: boolean;
  readonly text: string;
}

export interface JsonRenderResult {
  readonly lines: string[];
  readonly treeRows: JsonTreeRow[];
  readonly valid: boolean;
  readonly errorMessage?: string;
}

function formatPrimitiveValue(value: unknown, theme: ThemePalette): string {
  if (value === null) return `${fg(theme.syntaxKeyword)}${BOLD}null${RESET}`;
  if (typeof value === 'boolean') return `${fg(theme.syntaxKeyword)}${BOLD}${String(value)}${RESET}`;
  if (typeof value === 'number') return `${fg(theme.syntaxNumber)}${String(value)}${RESET}`;
  if (typeof value === 'string') {
    const safe = stripUnsafeAnsi(value);
    const clipped = safe.length > 120 ? `${safe.slice(0, 117)}…` : safe;
    return `${fg(theme.syntaxString)}"${clipped}"${RESET}`;
  }
  return `${fg(theme.text)}${String(value)}${RESET}`;
}

export function buildJsonTreeRows(
  data: unknown,
  collapsedPaths: ReadonlySet<string>,
  theme: ThemePalette
): JsonTreeRow[] {
  const rows: JsonTreeRow[] = [];

  function walk(node: unknown, keyLabel: string | null, nodePath: string, depth: number): void {
    const indent = '  '.repeat(depth);
    const keyPart = keyLabel !== null ? `${fg(theme.syntaxAttr)}${stripUnsafeAnsi(keyLabel)}${RESET}${fg(theme.syntaxOperator)}: ${RESET}` : '';

    if (Array.isArray(node)) {
      const collapsed = collapsedPaths.has(nodePath);
      const chevron = node.length === 0 ? '·' : collapsed ? '▸' : '▾';
      const badge = `${fg(theme.muted)}${DIM}[${node.length} ${node.length === 1 ? 'item' : 'itens'}]${RESET}`;
      rows.push({
        path: nodePath,
        depth,
        collapsible: node.length > 0,
        collapsed,
        text: `${indent}${fg(theme.accent)}${chevron}${RESET} ${keyPart}${badge}`,
      });
      if (!collapsed) {
        node.forEach((child, idx) => walk(child, `[${idx}]`, `${nodePath}[${idx}]`, depth + 1));
      }
      return;
    }

    if (node !== null && typeof node === 'object') {
      const entries = Object.entries(node as Record<string, unknown>);
      const collapsed = collapsedPaths.has(nodePath);
      const chevron = entries.length === 0 ? '·' : collapsed ? '▸' : '▾';
      const badge = `${fg(theme.muted)}${DIM}{${entries.length} ${entries.length === 1 ? 'chave' : 'chaves'}}${RESET}`;
      rows.push({
        path: nodePath,
        depth,
        collapsible: entries.length > 0,
        collapsed,
        text: `${indent}${fg(theme.accentAlt)}${chevron}${RESET} ${keyPart}${badge}`,
      });
      if (!collapsed) {
        for (const [k, v] of entries) {
          walk(v, k, `${nodePath}.${k}`, depth + 1);
        }
      }
      return;
    }

    rows.push({
      path: nodePath,
      depth,
      collapsible: false,
      collapsed: false,
      text: `${indent}  ${keyPart}${formatPrimitiveValue(node, theme)}`,
    });
  }

  walk(data, null, '$', 0);
  return rows;
}

export function collectAllCollapsiblePaths(data: unknown): string[] {
  const paths: string[] = [];
  function walk(node: unknown, nodePath: string): void {
    if (Array.isArray(node)) {
      if (node.length > 0) paths.push(nodePath);
      node.forEach((child, idx) => walk(child, `${nodePath}[${idx}]`));
    } else if (node !== null && typeof node === 'object') {
      const entries = Object.entries(node as Record<string, unknown>);
      if (entries.length > 0) paths.push(nodePath);
      for (const [k, v] of entries) walk(v, `${nodePath}.${k}`);
    }
  }
  walk(data, '$');
  return paths;
}

export function renderJsonDocument(
  content: string,
  theme: ThemePalette,
  mode: 'tree' | 'pretty' = 'tree',
  collapsedPaths: ReadonlySet<string> = new Set()
): JsonRenderResult {
  try {
    const parsed: unknown = JSON.parse(content);

    if (mode === 'pretty') {
      const formatted = JSON.stringify(parsed, null, 2);
      return {
        lines: renderCodeLines(formatted, { language: 'json', theme, showLineNumbers: true }),
        treeRows: [],
        valid: true,
      };
    }

    const treeRows = buildJsonTreeRows(parsed, collapsedPaths, theme);
    return {
      lines: treeRows.map((r) => r.text),
      treeRows,
      valid: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const header = [
      `${fg(theme.danger)}${BOLD}▲ JSON inválido detectado:${RESET} ${fg(theme.warning)}${stripUnsafeAnsi(msg)}${RESET}`,
      `${fg(theme.muted)}${ITALIC}Exibindo código-fonte bruto para diagnóstico:${RESET}`,
      '',
    ];
    const sourceLines = renderCodeLines(content, { language: 'json', theme, showLineNumbers: true });
    return {
      lines: [...header, ...sourceLines],
      treeRows: [],
      valid: false,
      errorMessage: msg,
    };
  }
}

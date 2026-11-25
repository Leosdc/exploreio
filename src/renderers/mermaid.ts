/**
 * Native Rich Terminal Mermaid Renderer (SPEC-003 / SPEC-004)
 * Delega o layout 2D (Sugiyama, redução de cruzamentos, roteamento ortogonal
 * e subgraphs reais em Canvas Grid2D) para o pacote oficial `@leosdc/termaid`,
 * preservando conformidade com os 3 temas do Exploreio, moldura embutida para
 * blocos Markdown e degradação segura (fail-safe) para código destacado.
 */

import { renderMermaid as renderTermaid } from '@leosdc/termaid';
import { bg, fg, type ThemePalette } from '../themes/palette.js';
import { BOLD, DIM, RESET, stripUnsafeAnsi, truncateAnsi, visibleLength } from '../tui/ansi.js';
import { renderCodeLines } from './code.js';

export interface RenderMermaidOptions {
  readonly width: number;
  readonly theme: ThemePalette;
  readonly mode?: 'rendered' | 'raw';
  readonly embedded?: boolean;
}

function wrapEmbeddedFrame(
  headerLabel: string,
  bodyLines: string[],
  width: number,
  theme: ThemePalette
): string[] {
  const safeWidth = Math.max(28, width);
  const badge = ` ◈ ${stripUnsafeAnsi(headerLabel)} `;
  const barLen = Math.max(2, safeWidth - visibleLength(badge) - 4);
  const out: string[] = [
    `${fg(theme.border)}╭─${RESET}${bg(theme.headerBg)}${fg(theme.accent)}${BOLD}${badge}${RESET}${fg(theme.border)}${'─'.repeat(barLen)}╮${RESET}`,
  ];
  for (const line of bodyLines) {
    out.push(`${fg(theme.border)}│${RESET} ${truncateAnsi(line, safeWidth - 4)}`);
  }
  out.push(`${fg(theme.border)}╰${'─'.repeat(Math.max(4, safeWidth - 2))}╯${RESET}`);
  return out;
}

export function renderMermaid(source: string, options: RenderMermaidOptions): string[] {
  const { width, theme, mode = 'rendered', embedded = false } = options;
  const safeWidth = Math.max(28, width);

  if (mode === 'raw') {
    return renderCodeLines(source, {
      language: 'plain',
      theme,
      showLineNumbers: true,
    });
  }

  const contentWidth = embedded ? Math.max(24, safeWidth - 4) : safeWidth;
  const result = renderTermaid(source, {
    theme: theme.name,
    maxWidth: contentWidth,
  });

  if (!result.ok) {
    const safeReason = stripUnsafeAnsi(result.error ?? 'Diagrama não suportado.');
    const fallbackBody = [
      `${fg(theme.warning)}${BOLD}▲ ${safeReason}${RESET}`,
      ...renderCodeLines(source, {
        language: 'plain',
        theme,
        showLineNumbers: true,
      }),
    ];
    return embedded
      ? wrapEmbeddedFrame(result.headerLabel, fallbackBody, safeWidth, theme)
      : [
          `${fg(theme.warning)}${BOLD}◈ ${stripUnsafeAnsi(result.headerLabel)}${RESET} ${fg(theme.muted)}${DIM}(${safeReason})${RESET}`,
          ...renderCodeLines(source, { language: 'plain', theme, showLineNumbers: true }),
        ];
  }

  if (embedded) {
    return wrapEmbeddedFrame(result.headerLabel, result.lines, safeWidth, theme);
  }

  return [
    `${fg(theme.accent)}${BOLD}◈ ${stripUnsafeAnsi(result.headerLabel)}${RESET} ${fg(theme.muted)}${DIM}· ${result.width}×${result.height} · @leosdc/termaid${RESET}`,
    `${fg(theme.border)}${'─'.repeat(Math.min(safeWidth, 56))}${RESET}`,
    '',
    ...result.lines,
  ];
}

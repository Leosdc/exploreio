/**
 * Native Rich Terminal Mermaid Renderer (SPEC-003)
 * Renderiza diagramas Mermaid (flowchart, sequence, state, class, er) em
 * arte Unicode/ANSI respeitando os 3 temas oficiais do Exploreio, com
 * adaptação automática à largura do painel e degradação segura (fail-safe).
 */

import { bg, fg, type RgbColor, type ThemePalette } from '../themes/palette.js';
import {
  BOLD,
  DIM,
  ITALIC,
  RESET,
  stripUnsafeAnsi,
  truncateAnsi,
  visibleLength,
} from '../tui/ansi.js';
import { renderCodeLines } from './code.js';
import {
  parseMermaid,
  type MermaidClassAst,
  type MermaidEdgeStyle,
  type MermaidFlowchartAst,
  type MermaidFlowEdge,
  type MermaidFlowNode,
  type MermaidNodeShape,
  type MermaidSequenceAst,
  type MermaidStateAst,
} from './mermaidParser.js';

export interface RenderMermaidOptions {
  readonly width: number;
  readonly theme: ThemePalette;
  readonly mode?: 'rendered' | 'raw';
  readonly embedded?: boolean;
}

interface NodeBox {
  readonly width: number;
  readonly lines: [string, string, string];
}

function shapeColor(shape: MermaidNodeShape, theme: ThemePalette): RgbColor {
  switch (shape) {
    case 'diamond':
      return theme.warning;
    case 'stadium':
      return theme.success;
    case 'cylinder':
      return theme.syntaxType;
    case 'round':
      return theme.accentAlt;
    case 'circle':
      return theme.dir;
    case 'rect':
    default:
      return theme.accent;
  }
}

function renderFlowBox(node: MermaidFlowNode, maxBoxWidth: number, theme: ThemePalette): NodeBox {
  const color = shapeColor(node.shape, theme);
  const safeMax = Math.max(10, maxBoxWidth);
  const innerLimit = Math.max(4, safeMax - 4);
  const label = truncateAnsi(stripUnsafeAnsi(node.label), innerLimit);
  const innerW = Math.max(4, visibleLength(label) + 2);
  const padTotal = innerW - visibleLength(label);
  const padLeft = Math.floor(padTotal / 2);
  const padRight = padTotal - padLeft;
  const centered = `${' '.repeat(padLeft)}${fg(theme.text)}${BOLD}${label}${RESET}${' '.repeat(padRight)}`;

  const c = (s: string): string => `${fg(color)}${s}${RESET}`;
  const bar = '─'.repeat(innerW);

  let top = c(`┌${bar}┐`);
  let mid = `${c('│')}${centered}${c('│')}`;
  let bot = c(`└${bar}┘`);

  if (node.shape === 'round') {
    top = c(`╭${bar}╮`);
    bot = c(`╰${bar}╯`);
  } else if (node.shape === 'stadium') {
    top = c(`╭${bar}╮`);
    mid = `${c('(')}${centered}${c(')')}`;
    bot = c(`╰${bar}╯`);
  } else if (node.shape === 'cylinder') {
    top = c(`╭${bar}╮`);
    mid = `${c('╞')}${centered}${c('╡')}`;
    bot = c(`╰${bar}╯`);
  } else if (node.shape === 'diamond') {
    top = c(`╭${bar}╮`);
    mid = `${c('◇')}${centered}${c('◇')}`;
    bot = c(`╰${bar}╯`);
  } else if (node.shape === 'circle') {
    top = c(`╭${bar}╮`);
    mid = `${c('◉')}${centered}${c('◉')}`;
    bot = c(`╰${bar}╯`);
  }

  return { width: innerW + 2, lines: [top, mid, bot] };
}

interface LayeredGraph {
  readonly layers: MermaidFlowNode[][];
  readonly nodeLayer: Map<string, number>;
  readonly backEdges: MermaidFlowEdge[];
}

function computeFlowLayers(ast: MermaidFlowchartAst): LayeredGraph {
  const nodeById = new Map(ast.nodes.map((n) => [n.id, n]));
  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const n of ast.nodes) {
    adj.set(n.id, []);
    inDegree.set(n.id, 0);
  }

  // Detecta back-edges via DFS iterativo/recursivo com marcação de pilha (O(V+E), ciclo-seguro)
  const backEdgeSet = new Set<MermaidFlowEdge>();
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const outgoingEdges = new Map<string, MermaidFlowEdge[]>();
  for (const e of ast.edges) {
    const list = outgoingEdges.get(e.from) ?? [];
    list.push(e);
    outgoingEdges.set(e.from, list);
  }

  const dfs = (id: string): void => {
    visited.add(id);
    inStack.add(id);
    for (const edge of outgoingEdges.get(id) ?? []) {
      if (edge.from === edge.to || inStack.has(edge.to)) {
        backEdgeSet.add(edge);
      } else if (!visited.has(edge.to) && nodeById.has(edge.to)) {
        dfs(edge.to);
      }
    }
    inStack.delete(id);
  };

  for (const n of ast.nodes) {
    if (!visited.has(n.id)) dfs(n.id);
  }

  for (const edge of ast.edges) {
    if (backEdgeSet.has(edge)) continue;
    if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) continue;
    adj.get(edge.from)?.push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  // Atribuição de camadas por ordem topológica (Kahn)
  const nodeLayer = new Map<string, number>();
  const queue: string[] = [];
  for (const n of ast.nodes) {
    if ((inDegree.get(n.id) ?? 0) === 0) {
      nodeLayer.set(n.id, 0);
      queue.push(n.id);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++] ?? '';
    const curLayer = nodeLayer.get(cur) ?? 0;
    for (const next of adj.get(cur) ?? []) {
      const prevLayer = nodeLayer.get(next) ?? 0;
      nodeLayer.set(next, Math.max(prevLayer, curLayer + 1));
      const nextDeg = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, nextDeg);
      if (nextDeg === 0) queue.push(next);
    }
  }

  for (const n of ast.nodes) {
    if (!nodeLayer.has(n.id)) nodeLayer.set(n.id, 0);
  }

  const maxLayer = Math.max(0, ...nodeLayer.values());
  const layers: MermaidFlowNode[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const n of ast.nodes) {
    const idx = nodeLayer.get(n.id) ?? 0;
    layers[idx]?.push(n);
  }

  const orderedLayers =
    ast.direction === 'BT' || ast.direction === 'RL' ? [...layers].reverse() : layers;

  return { layers: orderedLayers, nodeLayer, backEdges: Array.from(backEdgeSet) };
}

function edgeArrowGlyph(style: MermaidEdgeStyle, horizontal: boolean, reversed = false): string {
  if (horizontal) {
    if (style === 'bidirectional') return '◀──▶';
    if (style === 'line') return '────';
    if (style === 'dotted') return reversed ? '◀╌╌╌' : '╌╌╌▶';
    if (style === 'thick') return reversed ? '◀═══' : '═══▶';
    return reversed ? '◀───' : '───▶';
  }
  if (style === 'dotted') return '┆';
  if (style === 'thick') return '║';
  return '│';
}

function tryRenderHorizontalChain(
  ast: MermaidFlowchartAst,
  layers: MermaidFlowNode[][],
  width: number,
  theme: ThemePalette
): string[] | null {
  if (layers.some((layer) => layer.length !== 1)) return null;
  const chain = layers.map((l) => l[0]).filter((n): n is MermaidFlowNode => Boolean(n));
  if (chain.length < 2) return null;

  const reversed = ast.direction === 'RL';
  const maxBoxW = Math.max(12, Math.floor((width - (chain.length - 1) * 8) / chain.length));
  const boxes = chain.map((n) => renderFlowBox(n, maxBoxW, theme));

  const connectors: { width: number; top: string; mid: string; bot: string }[] = [];
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i];
    const b = chain[i + 1];
    const edge = ast.edges.find(
      (e) => (e.from === a?.id && e.to === b?.id) || (reversed && e.from === b?.id && e.to === a?.id)
    );
    const arrow = edgeArrowGlyph(edge?.style ?? 'solid', true, reversed);
    const labelText = edge?.label ? truncateAnsi(edge.label, 14) : '';
    const connW = Math.max(arrow.length + 2, visibleLength(labelText) + 2);
    const topPad = Math.max(0, connW - visibleLength(labelText));
    const topLeft = Math.floor(topPad / 2);
    const topLine = labelText
      ? `${' '.repeat(topLeft)}${fg(theme.syntaxString)}${DIM}${labelText}${RESET}${' '.repeat(topPad - topLeft)}`
      : ' '.repeat(connW);

    const arrowPad = Math.max(0, connW - arrow.length);
    const aLeft = Math.floor(arrowPad / 2);
    const fillCh = edge?.style === 'dotted' ? '╌' : edge?.style === 'thick' ? '═' : '─';
    const midLine = `${fg(theme.border)}${fillCh.repeat(aLeft)}${fg(theme.accentAlt)}${arrow}${fg(theme.border)}${fillCh.repeat(arrowPad - aLeft)}${RESET}`;
    connectors.push({ width: connW, top: topLine, mid: midLine, bot: ' '.repeat(connW) });
  }

  const totalWidth =
    boxes.reduce((sum, b) => sum + b.width, 0) +
    connectors.reduce((sum, c) => sum + c.width, 0);
  if (totalWidth > width) return null;

  const row0: string[] = [];
  const row1: string[] = [];
  const row2: string[] = [];
  boxes.forEach((box, idx) => {
    row0.push(box.lines[0]);
    row1.push(box.lines[1]);
    row2.push(box.lines[2]);
    const conn = connectors[idx];
    if (conn) {
      row0.push(conn.top);
      row1.push(conn.mid);
      row2.push(conn.bot);
    }
  });

  return [row0.join(''), row1.join(''), row2.join('')];
}

function renderFlowchart(ast: MermaidFlowchartAst, width: number, theme: ThemePalette): string[] {
  const safeWidth = Math.max(28, width);
  const { layers, backEdges } = computeFlowLayers(ast);
  const out: string[] = [];

  if (ast.subgraphs.length > 0) {
    const summary = ast.subgraphs
      .map((sg) => `${fg(theme.accentAlt)}[${sg.title}]${RESET}`)
      .join(` ${fg(theme.muted)}·${RESET} `);
    out.push(`${fg(theme.muted)}${DIM}Subgraphs:${RESET} ${summary}`);
  }

  if (ast.direction === 'LR' || ast.direction === 'RL') {
    const horizontal = tryRenderHorizontalChain(ast, layers, safeWidth, theme);
    if (horizontal) {
      out.push(...horizontal);
      if (backEdges.length > 0) {
        out.push('');
        for (const be of backEdges) {
          const lbl = be.label ? ` ${fg(theme.syntaxString)}[${be.label}]${RESET}` : '';
          out.push(`${fg(theme.warning)}↩${RESET} ${fg(theme.text)}${be.from}${RESET} ${fg(theme.border)}──▶${RESET} ${fg(theme.text)}${be.to}${RESET}${lbl}`);
        }
      }
      return out;
    }
  }

  const nodeLabelById = new Map(ast.nodes.map((n) => [n.id, n.label]));

  layers.forEach((layer, layerIdx) => {
    const gap = 2;
    const perBoxMax = Math.max(12, Math.floor((safeWidth - Math.max(0, layer.length - 1) * gap) / Math.max(1, layer.length)));
    const boxes = layer.map((n) => renderFlowBox(n, Math.min(34, perBoxMax), theme));

    // Agrupa caixas em linhas horizontais caso haja muitos nós na mesma camada
    let cursor = 0;
    while (cursor < boxes.length) {
      const rowBoxes: NodeBox[] = [];
      let rowW = 0;
      while (cursor < boxes.length) {
        const next = boxes[cursor];
        if (!next) break;
        const needed = rowBoxes.length === 0 ? next.width : gap + next.width;
        if (rowBoxes.length > 0 && rowW + needed > safeWidth) break;
        rowBoxes.push(next);
        rowW += needed;
        cursor++;
      }

      const sep = ' '.repeat(gap);
      out.push(rowBoxes.map((b) => b.lines[0]).join(sep));
      out.push(rowBoxes.map((b) => b.lines[1]).join(sep));
      out.push(rowBoxes.map((b) => b.lines[2]).join(sep));
    }

    // Conectores para a próxima camada
    const nextLayer = layers[layerIdx + 1];
    if (nextLayer) {
      const nextIds = new Set(nextLayer.map((n) => n.id));
      const layerIds = new Set(layer.map((n) => n.id));
      const directEdges = ast.edges.filter((e) =>
        ast.direction === 'BT' || ast.direction === 'RL'
          ? nextIds.has(e.from) && layerIds.has(e.to)
          : layerIds.has(e.from) && nextIds.has(e.to)
      );

      if (directEdges.length === 1 && layer.length === 1 && nextLayer.length === 1) {
        const e = directEdges[0];
        const stem = edgeArrowGlyph(e?.style ?? 'solid', false);
        const pad = ' '.repeat(Math.max(2, Math.floor((boxes[0]?.width ?? 8) / 2)));
        const lbl = e?.label ? ` ${fg(theme.syntaxString)}${DIM}${truncateAnsi(e.label, safeWidth - 10)}${RESET}` : '';
        out.push(`${pad}${fg(theme.border)}${stem}${RESET}${lbl}`);
        out.push(`${pad}${fg(theme.accentAlt)}▼${RESET}`);
      } else if (directEdges.length > 0) {
        for (const e of directEdges.slice(0, 6)) {
          const arrow = edgeArrowGlyph(e.style, true);
          const fromLbl = truncateAnsi(nodeLabelById.get(e.from) ?? e.from, 18);
          const toLbl = truncateAnsi(nodeLabelById.get(e.to) ?? e.to, 18);
          const edgeLbl = e.label ? ` ${fg(theme.syntaxString)}[${truncateAnsi(e.label, 18)}]${RESET}` : '';
          out.push(
            `  ${fg(theme.border)}└─${RESET} ${fg(theme.muted)}${fromLbl}${RESET} ${fg(theme.accentAlt)}${arrow}${RESET} ${fg(theme.text)}${toLbl}${RESET}${edgeLbl}`
          );
        }
        if (directEdges.length > 6) {
          out.push(`  ${fg(theme.muted)}${DIM}… (+${directEdges.length - 6} conexões)${RESET}`);
        }
      } else {
        out.push(`   ${fg(theme.border)}│${RESET}`);
        out.push(`   ${fg(theme.accentAlt)}▼${RESET}`);
      }
    }
  });

  if (backEdges.length > 0) {
    out.push('');
    for (const be of backEdges) {
      const fromLbl = truncateAnsi(nodeLabelById.get(be.from) ?? be.from, 20);
      const toLbl = truncateAnsi(nodeLabelById.get(be.to) ?? be.to, 20);
      const lbl = be.label ? ` ${fg(theme.syntaxString)}[${truncateAnsi(be.label, 20)}]${RESET}` : '';
      out.push(`${fg(theme.warning)}↩${RESET} ${fg(theme.text)}${fromLbl}${RESET} ${fg(theme.border)}──▶${RESET} ${fg(theme.text)}${toLbl}${RESET}${lbl}`);
    }
  }

  return out;
}

function renderSequenceCompact(ast: MermaidSequenceAst, width: number, theme: ThemePalette): string[] {
  const out: string[] = [];
  const labelMap = new Map(ast.participants.map((p) => [p.id, p.label]));
  const headerNames = ast.participants
    .map((p) => `${fg(p.isActor ? theme.accentAlt : theme.accent)}${BOLD}${p.label}${RESET}`)
    .join(` ${fg(theme.muted)}·${RESET} `);
  out.push(truncateAnsi(`${fg(theme.muted)}Participantes:${RESET} ${headerNames}`, width));
  out.push(`${fg(theme.border)}${'─'.repeat(Math.min(width, 48))}${RESET}`);

  let indent = 0;
  for (const item of ast.items) {
    if (item.kind === 'block') {
      if (item.keyword === 'end') {
        indent = Math.max(0, indent - 1);
        out.push(`${'  '.repeat(indent)}${fg(theme.accentAlt)}└─ end${RESET}`);
      } else if (item.keyword === 'else') {
        out.push(`${'  '.repeat(Math.max(0, indent - 1))}${fg(theme.accentAlt)}├─ else${item.label ? ` ${item.label}` : ''}${RESET}`);
      } else {
        out.push(`${'  '.repeat(indent)}${fg(theme.accentAlt)}${BOLD}┌─ [${item.keyword}]${RESET} ${fg(theme.text)}${item.label}${RESET}`);
        indent++;
      }
    } else if (item.kind === 'note') {
      out.push(`${'  '.repeat(indent)}${fg(theme.warning)}✎ Note (${item.targets.join(', ')}):${RESET} ${fg(theme.text)}${ITALIC}${item.text}${RESET}`);
    } else {
      const from = labelMap.get(item.from) ?? item.from;
      const to = labelMap.get(item.to) ?? item.to;
      const arrow = item.dashed ? '╌╌▶' : '──▶';
      const pad = '  '.repeat(indent);
      const header = `${pad}${fg(theme.accent)}${from}${RESET} ${fg(theme.accentAlt)}${arrow}${RESET} ${fg(theme.accent)}${to}${RESET}`;
      const single = `${header}: ${fg(theme.text)}${item.label}${RESET}`;
      if (visibleLength(single) <= width) {
        out.push(single);
      } else {
        out.push(truncateAnsi(header, width));
        if (item.label) {
          out.push(truncateAnsi(`${pad}  ${fg(theme.muted)}↳${RESET} ${fg(theme.text)}${item.label}${RESET}`, width));
        }
      }
    }
  }
  return out;
}

function renderSequenceDiagram(ast: MermaidSequenceAst, width: number, theme: ThemePalette): string[] {
  const safeWidth = Math.max(28, width);
  const count = ast.participants.length;
  const colWidth = Math.floor(safeWidth / Math.max(1, count));

  // Se o painel for estreito demais para as lifelines lado a lado, usa layout compacto
  if (count > 5 || colWidth < 16) {
    return renderSequenceCompact(ast, safeWidth, theme);
  }

  const centers = ast.participants.map((_, idx) => idx * colWidth + Math.floor(colWidth / 2));
  const indexById = new Map(ast.participants.map((p, idx) => [p.id, idx]));
  const out: string[] = [];

  // Cabeçalho dos participantes em caixas Unicode
  const topParts: string[] = [];
  const midParts: string[] = [];
  const botParts: string[] = [];
  for (const p of ast.participants) {
    const innerW = Math.max(4, Math.min(colWidth - 4, visibleLength(p.label) + 2));
    const txt = truncateAnsi(p.label, innerW - 2);
    const pad = Math.max(0, innerW - visibleLength(txt));
    const pl = Math.floor(pad / 2);
    const pr = pad - pl;
    const boxW = innerW + 2;
    const outerPad = Math.max(0, colWidth - boxW);
    const ol = Math.floor(outerPad / 2);
    const or = outerPad - ol;
    const color = p.isActor ? theme.accentAlt : theme.accent;

    topParts.push(`${' '.repeat(ol)}${fg(color)}╭${'─'.repeat(innerW)}╮${RESET}${' '.repeat(or)}`);
    midParts.push(`${' '.repeat(ol)}${fg(color)}│${RESET}${' '.repeat(pl)}${fg(theme.text)}${BOLD}${txt}${RESET}${' '.repeat(pr)}${fg(color)}│${RESET}${' '.repeat(or)}`);
    botParts.push(`${' '.repeat(ol)}${fg(color)}╰${'─'.repeat(innerW)}╯${RESET}${' '.repeat(or)}`);
  }
  out.push(topParts.join(''), midParts.join(''), botParts.join(''));

  const renderLifelineRow = (): string => {
    const chars = Array.from({ length: count * colWidth }, () => ' ');
    for (const c of centers) {
      if (c >= 0 && c < chars.length) chars[c] = '│';
    }
    return `${fg(theme.border)}${chars.join('').trimEnd()}${RESET}`;
  };

  for (const item of ast.items) {
    if (item.kind === 'block') {
      if (item.keyword === 'end') {
        out.push(`${fg(theme.accentAlt)}└─ end ${'─'.repeat(Math.max(4, safeWidth - 10))}${RESET}`);
      } else if (item.keyword === 'else') {
        out.push(`${fg(theme.accentAlt)}├─ else${item.label ? `: ${item.label}` : ''} ${'╌'.repeat(Math.max(4, safeWidth - 16 - visibleLength(item.label)))}${RESET}`);
      } else {
        out.push(`${fg(theme.accentAlt)}${BOLD}┌─[${item.keyword}]${RESET} ${fg(theme.text)}${truncateAnsi(item.label, safeWidth - 14)}${RESET}`);
      }
      continue;
    }

    if (item.kind === 'note') {
      const noteText = truncateAnsi(item.text, safeWidth - 14);
      out.push(`${fg(theme.warning)}╭─ NOTE (${item.targets.join(', ')}) ─╮${RESET}`);
      out.push(`${fg(theme.warning)}│${RESET} ${fg(theme.text)}${ITALIC}${noteText}${RESET}`);
      out.push(`${fg(theme.warning)}╰${'─'.repeat(Math.min(safeWidth - 2, Math.max(12, visibleLength(noteText) + 2)))}╯${RESET}`);
      continue;
    }

    const fromIdx = indexById.get(item.from) ?? 0;
    const toIdx = indexById.get(item.to) ?? 0;
    const fromX = centers[fromIdx] ?? 0;
    const toX = centers[toIdx] ?? 0;

    if (fromIdx === toIdx) {
      const prefix = ' '.repeat(fromX);
      out.push(`${prefix}${fg(theme.accentAlt)}├─▶${RESET} ${fg(theme.text)}${truncateAnsi(item.label, safeWidth - fromX - 5)}${RESET}`);
      continue;
    }

    const leftX = Math.min(fromX, toX);
    const rightX = Math.max(fromX, toX);
    const span = Math.max(2, rightX - leftX - 1);
    const goingRight = toX > fromX;

    // Linha do rótulo acima da seta
    const labelText = truncateAnsi(item.label, Math.max(6, span + 6));
    const labelStart = Math.max(0, Math.min(safeWidth - visibleLength(labelText), leftX + Math.floor((span - visibleLength(labelText)) / 2) + 1));
    const labelChars = Array.from({ length: Math.max(count * colWidth, labelStart + visibleLength(labelText)) }, () => ' ');
    for (const c of centers) {
      if (c >= 0 && c < labelChars.length) labelChars[c] = '│';
    }
    const prefixPlain = labelChars.slice(0, labelStart).join('');
    out.push(`${fg(theme.border)}${prefixPlain}${RESET}${fg(theme.text)}${labelText}${RESET}`);

    // Linha da seta entre lifelines
    const fillCh = item.dashed ? '╌' : '─';
    const arrowBody = goingRight
      ? `${fillCh.repeat(Math.max(1, span - 1))}▶`
      : `◀${fillCh.repeat(Math.max(1, span - 1))}`;

    let row = '';
    for (let pos = 0; pos < count * colWidth; pos++) {
      if (pos === leftX) {
        row += `${fg(theme.accentAlt)}${goingRight ? '├' : '┤'}${RESET}`;
      } else if (pos > leftX && pos < rightX) {
        if (pos === leftX + 1) {
          row += `${fg(theme.accentAlt)}${arrowBody}${RESET}`;
        }
      } else if (pos === rightX) {
        row += `${fg(theme.accentAlt)}${goingRight ? '┤' : '├'}${RESET}`;
      } else if (centers.includes(pos)) {
        row += `${fg(theme.border)}│${RESET}`;
      } else {
        row += ' ';
      }
    }
    out.push(row.trimEnd());
  }

  out.push(renderLifelineRow());
  return out;
}

function renderStateDiagram(ast: MermaidStateAst, width: number, theme: ThemePalette): string[] {
  const safeWidth = Math.max(28, width);
  const out: string[] = [];

  const formatState = (id: string, isTarget: boolean): string => {
    if (id === '[*]') {
      return isTarget ? `${fg(theme.danger)}${BOLD}◉ FIM${RESET}` : `${fg(theme.success)}${BOLD}● INÍCIO${RESET}`;
    }
    const label = ast.labels[id] ? `${id}: ${ast.labels[id]}` : id;
    return `${fg(theme.accent)}╭─${RESET} ${fg(theme.text)}${BOLD}${truncateAnsi(label, 24)}${RESET} ${fg(theme.accent)}─╮${RESET}`;
  };

  for (const t of ast.transitions) {
    const fromStr = formatState(t.from, false);
    const toStr = formatState(t.to, true);
    const lbl = t.label ? ` ${fg(theme.syntaxString)}[${truncateAnsi(t.label, 22)}]${RESET}` : '';
    const line = `${fromStr} ${fg(theme.accentAlt)}──▶${RESET} ${toStr}${lbl}`;
    out.push(truncateAnsi(line, safeWidth));
  }

  if (out.length === 0) {
    for (const [id, desc] of Object.entries(ast.labels)) {
      out.push(`${fg(theme.accent)}▸ ${id}${RESET}: ${fg(theme.text)}${desc}${RESET}`);
    }
  }
  return out;
}

function formatRelationOp(op: string): string {
  if (op.includes('|>')) return '──▷';
  if (op.includes('<|')) return '◁──';
  if (op.includes('*')) return '◆──';
  if (op.includes('o--') || op.includes('--o')) return '◇──';
  if (op.includes('..')) return '╌╌▶';
  if (op.includes('{') || op.includes('}')) return ` ${op} `;
  return '──▶';
}

function renderClassOrErDiagram(ast: MermaidClassAst, width: number, theme: ThemePalette): string[] {
  const safeWidth = Math.max(28, width);
  const out: string[] = [];
  const boxMaxW = Math.min(44, safeWidth - 2);

  for (const entity of ast.entities) {
    const title = truncateAnsi(entity.name, boxMaxW - 4);
    const memberLines = entity.members.map((m) => truncateAnsi(m, boxMaxW - 4));
    const innerW = Math.max(
      visibleLength(title) + 2,
      ...memberLines.map((m) => visibleLength(m) + 2),
      12
    );

    const b = (s: string): string => `${fg(ast.type === 'er' ? theme.syntaxType : theme.accent)}${s}${RESET}`;
    out.push(b(`┌${'─'.repeat(innerW)}┐`));
    const tPad = Math.max(0, innerW - visibleLength(title) - 1);
    out.push(`${b('│')} ${fg(theme.text)}${BOLD}${title}${RESET}${' '.repeat(tPad)}${b('│')}`);

    if (memberLines.length > 0) {
      out.push(b(`├${'─'.repeat(innerW)}┤`));
      for (const m of memberLines) {
        const mPad = Math.max(0, innerW - visibleLength(m) - 1);
        out.push(`${b('│')} ${fg(theme.muted)}${m}${RESET}${' '.repeat(mPad)}${b('│')}`);
      }
    }
    out.push(b(`└${'─'.repeat(innerW)}┘`));
  }

  if (ast.relations.length > 0) {
    out.push(`${fg(theme.muted)}${DIM}Relacionamentos:${RESET}`);
    for (const rel of ast.relations) {
      const op = formatRelationOp(rel.operator);
      const lbl = rel.label ? ` ${fg(theme.syntaxString)}: ${truncateAnsi(rel.label, 24)}${RESET}` : '';
      out.push(
        truncateAnsi(
          `  ${fg(theme.accent)}${rel.from}${RESET} ${fg(theme.accentAlt)}${op}${RESET} ${fg(theme.accent)}${rel.to}${RESET}${lbl}`,
          safeWidth
        )
      );
    }
  }

  return out;
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

  const parsed = parseMermaid(source);
  if (!parsed.ok || !parsed.ast) {
    const safeReason = stripUnsafeAnsi(parsed.error ?? 'Diagrama não suportado.');
    const fallbackBody = [
      `${fg(theme.warning)}${BOLD}▲ ${safeReason}${RESET}`,
      ...renderCodeLines(source, {
        language: 'plain',
        theme,
        showLineNumbers: true,
      }),
    ];
    return embedded
      ? wrapEmbeddedFrame(parsed.headerLabel, fallbackBody, safeWidth, theme)
      : [
          `${fg(theme.warning)}${BOLD}◈ ${stripUnsafeAnsi(parsed.headerLabel)}${RESET} ${fg(theme.muted)}${DIM}(${safeReason})${RESET}`,
          ...renderCodeLines(source, { language: 'plain', theme, showLineNumbers: true }),
        ];
  }

  const contentWidth = embedded ? Math.max(24, safeWidth - 4) : safeWidth;
  let diagramLines: string[];

  switch (parsed.ast.type) {
    case 'flowchart':
      diagramLines = renderFlowchart(parsed.ast, contentWidth, theme);
      break;
    case 'sequence':
      diagramLines = renderSequenceDiagram(parsed.ast, contentWidth, theme);
      break;
    case 'state':
      diagramLines = renderStateDiagram(parsed.ast, contentWidth, theme);
      break;
    case 'class':
    case 'er':
      diagramLines = renderClassOrErDiagram(parsed.ast, contentWidth, theme);
      break;
  }

  if (embedded) {
    return wrapEmbeddedFrame(parsed.headerLabel, diagramLines, safeWidth, theme);
  }

  const meta =
    parsed.ast.type === 'flowchart'
      ? `${parsed.ast.nodes.length} nó(s) · ${parsed.ast.edges.length} aresta(s)`
      : parsed.ast.type === 'sequence'
        ? `${parsed.ast.participants.length} participante(s) · ${parsed.ast.items.length} evento(s)`
        : parsed.ast.type === 'state'
          ? `${parsed.ast.transitions.length} transição(ões)`
          : `${parsed.ast.entities.length} entidade(s) · ${parsed.ast.relations.length} relação(ões)`;

  return [
    `${fg(theme.accent)}${BOLD}◈ ${stripUnsafeAnsi(parsed.headerLabel)}${RESET} ${fg(theme.muted)}${DIM}· ${meta}${RESET}`,
    `${fg(theme.border)}${'─'.repeat(Math.min(safeWidth, 56))}${RESET}`,
    '',
    ...diagramLines,
  ];
}

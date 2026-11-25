import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SafeFilePreview } from '../fs/explorer.js';
import { detectDocumentKind, renderDocument } from '../renderers/index.js';
import { renderMarkdown } from '../renderers/markdown.js';
import { renderMermaid } from '../renderers/mermaid.js';
import { MAX_MERMAID_LINES, parseMermaid } from '../renderers/mermaidParser.js';
import { getTheme, THEME_ORDER } from '../themes/palette.js';
import { stripAnsi } from '../tui/ansi.js';

describe('Mermaid Parser & Renderer (SPEC-003)', () => {
  const theme = getTheme('midnight');

  it('faz parsing e renderiza flowchart LR horizontal e flowchart TD com formas, rótulos, subgraph e ciclos', () => {
    const lr = [
      'flowchart LR',
      '  A([Início]) --> B{Válido?}',
      '  B -->|Sim| C[(Banco)]',
    ].join('\n');

    const parsedLr = parseMermaid(lr);
    assert.equal(parsedLr.ok, true);
    assert.equal(parsedLr.type, 'flowchart');
    assert.equal(parsedLr.headerLabel, 'MERMAID · FLOWCHART LR');

    const renderedLr = renderMermaid(lr, { width: 100, theme }).map(stripAnsi).join('\n');
    assert.ok(renderedLr.includes('Início'));
    assert.ok(renderedLr.includes('Válido?'));
    assert.ok(renderedLr.includes('Banco'));
    assert.ok(renderedLr.includes('▶'));

    const tdCycle = [
      'flowchart TD',
      '  subgraph Pipeline[Fluxo Principal]',
      '    Start[Receber] --> Check{OK?}',
      '    Check -->|Não| Start',
      '    Check -->|Sim| Done([Concluído])',
      '  end',
    ].join('\n');

    const renderedTd = renderMermaid(tdCycle, { width: 80, theme }).map(stripAnsi).join('\n');
    assert.ok(renderedTd.includes('Fluxo Principal'));
    assert.ok(renderedTd.includes('Receber'));
    assert.ok(renderedTd.includes('Concluído'));
    assert.ok(renderedTd.includes('↩'), 'deve sinalizar back-edge em grafo cíclico sem loop infinito');
  });

  it('faz parsing e renderiza sequenceDiagram com participantes, setas, notas, blocos e fallback compacto', () => {
    const seq = [
      'sequenceDiagram',
      '  actor User as Usuário',
      '  participant API as Exploreio API',
      '  User->>API: Abrir arquivo',
      '  Note over API: Sanitiza ANSI',
      '  alt Sucesso',
      '    API-->>User: Renderizado',
      '  else Erro',
      '    API-->>User: Fallback',
      '  end',
    ].join('\n');

    const parsed = parseMermaid(seq);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.type, 'sequence');

    const wide = renderMermaid(seq, { width: 80, theme }).map(stripAnsi).join('\n');
    assert.ok(wide.includes('Usuário'));
    assert.ok(wide.includes('Exploreio API'));
    assert.ok(wide.includes('Abrir arquivo'));
    assert.ok(wide.includes('NOTE'));
    assert.ok(wide.includes('[alt]'));
    assert.ok(wide.includes('▶') && wide.includes('◀'));

    // Largura estreita ativa layout compacto sem quebrar
    const narrow = renderMermaid(seq, { width: 26, theme }).map(stripAnsi).join('\n');
    assert.ok(narrow.includes('Participantes:'));
    assert.ok(narrow.includes('Abrir arquivo'));
  });

  it('faz parsing e renderiza stateDiagram-v2, classDiagram e erDiagram', () => {
    const stateSrc = [
      'stateDiagram-v2',
      '  state "Aguardando" as Idle',
      '  [*] --> Idle',
      '  Idle --> Running : iniciar',
      '  Running --> [*]',
    ].join('\n');
    const stateOut = renderMermaid(stateSrc, { width: 80, theme }).map(stripAnsi).join('\n');
    assert.ok(stateOut.includes('INÍCIO'));
    assert.ok(stateOut.includes('Aguardando'));
    assert.ok(stateOut.includes('iniciar'));
    assert.ok(stateOut.includes('FIM'));

    const classSrc = [
      'classDiagram',
      '  class Renderer {',
      '    +render() string[]',
      '  }',
      '  MermaidRenderer --|> Renderer : implementa',
    ].join('\n');
    const classOut = renderMermaid(classSrc, { width: 80, theme }).map(stripAnsi).join('\n');
    assert.ok(classOut.includes('Renderer'));
    assert.ok(classOut.includes('+render() string[]'));
    assert.ok(classOut.includes('──▷'));

    const erSrc = [
      'erDiagram',
      '  USER ||--o{ DOCUMENT : owns',
      '  USER {',
      '    string id PK',
      '  }',
    ].join('\n');
    const erOut = renderMermaid(erSrc, { width: 80, theme }).map(stripAnsi).join('\n');
    assert.ok(erOut.includes('USER'));
    assert.ok(erOut.includes('string id PK'));
    assert.ok(erOut.includes('owns'));
  });

  it('integra blocos ```mermaid inline no renderMarkdown e roteia arquivos .mmd/.mermaid em renderDocument', () => {
    const md = [
      '# Arquitetura',
      '',
      '```mermaid',
      'flowchart LR',
      '  CLI[Exploreio] --> MD[Markdown] --> MMD[Mermaid]',
      '```',
    ].join('\n');

    const mdLines = renderMarkdown(md, 90, theme, 'rendered').map(stripAnsi).join('\n');
    assert.ok(mdLines.includes('MERMAID · FLOWCHART LR'));
    assert.ok(mdLines.includes('Exploreio'));
    assert.ok(mdLines.includes('Mermaid'));

    assert.equal(detectDocumentKind('/tmp/diagram.mmd', false), 'mermaid');
    assert.equal(detectDocumentKind('/tmp/flow.mermaid', false), 'mermaid');

    const preview: SafeFilePreview = {
      filePath: '/tmp/flow.mmd',
      size: 64,
      isBinary: false,
      truncated: false,
      magicLabel: 'Text',
      rawHead: new Uint8Array(),
      text: 'flowchart TD\n  A[Start] --> B[End]',
    };

    const renderedDoc = renderDocument(preview, { width: 80, theme, preferredMode: 'rendered' });
    assert.equal(renderedDoc.kind, 'mermaid');
    assert.equal(renderedDoc.badge, 'MERMAID · DIAGRAM');
    assert.ok(renderedDoc.lines.map(stripAnsi).join('\n').includes('Start'));

    const rawDoc = renderDocument(preview, { width: 80, theme, preferredMode: 'raw' });
    assert.equal(rawDoc.badge, 'MERMAID · RAW');
    assert.ok(rawDoc.lines.map(stripAnsi).join('\n').includes('flowchart TD'));
  });

  it('aplica fallback seguro, respeita limite anti-OOM, sanitiza ANSI malicioso e suporta os 3 temas', () => {
    const unsupported = 'gantt\n  title Cronograma\n  section A\n  Task1 :a1, 2026-01-01, 5d';
    const parsedUnsupported = parseMermaid(unsupported);
    assert.equal(parsedUnsupported.ok, false);
    const fallbackOut = renderMermaid(unsupported, { width: 80, theme }).map(stripAnsi).join('\n');
    assert.ok(fallbackOut.includes('MERMAID · GANTT'));
    assert.ok(fallbackOut.includes('Cronograma'));

    const huge = ['flowchart TD', ...Array.from({ length: MAX_MERMAID_LINES + 5 }, (_, i) => `N${i} --> N${i + 1}`)].join('\n');
    const parsedHuge = parseMermaid(huge);
    assert.equal(parsedHuge.ok, false);
    assert.ok(parsedHuge.error?.includes(String(MAX_MERMAID_LINES)));

    const malicious = 'flowchart LR\n  A[\x1b]52;c;ZGF0YQ==\x07Seguro] --> B[Fim]';
    for (const themeName of THEME_ORDER) {
      const lines = renderMermaid(malicious, { width: 80, theme: getTheme(themeName) });
      const rawJoined = lines.join('\n');
      assert.ok(!rawJoined.includes('\x1b]52'), 'nunca deve vazar sequência OSC maliciosa');
      assert.ok(stripAnsi(rawJoined).includes('Seguro'));
    }
  });
});

#!/usr/bin/env node
/**
 * Exploreio CLI Entrypoint (SPEC-001)
 * Uso:
 *   exploreio [diretorio|arquivo]            Abre a TUI estilo Yazi (ou direto no Leitor se arquivo)
 *   exploreio --print <arquivo>              Renderiza o arquivo lindamente direto no prompt/stdout
 *   exploreio --mode <rendered|raw|tree|pretty|reader|source>
 *   exploreio --theme <midnight|parchment|nord>
 */

import fs from 'node:fs/promises';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeReadFilePreview } from './fs/explorer.js';
import { renderDocument, type ViewMode } from './renderers/index.js';
import { fg, getTheme, type ThemeName, type ThemePalette } from './themes/palette.js';
import { BOLD, DIM, RESET } from './tui/ansi.js';
import { ExploreioApp } from './tui/app.js';

export const VERSION = '0.5.0';

export function loadSavedDefaultTheme(): ThemeName {
  try {
    const rcPath = path.join(os.homedir(), '.exploreiorc.json');
    if (!existsSync(rcPath)) return 'midnight';
    const raw = JSON.parse(readFileSync(rcPath, 'utf8')) as { theme?: string };
    return getTheme(raw.theme).name;
  } catch {
    return 'midnight';
  }
}

export interface ParsedCliArgs {
  readonly target: string;
  readonly printMode: boolean;
  readonly theme: ThemeName;
  readonly viewMode?: ViewMode;
  readonly width?: number;
  readonly showHidden: boolean;
  readonly singleFile: boolean;
  readonly showHelp: boolean;
  readonly showVersion: boolean;
}

const VALID_MODES = new Set<ViewMode>(['rendered', 'raw', 'tree', 'pretty', 'reader', 'source', 'code', 'hex']);

export function parseCliArgs(argv: readonly string[], defaultTheme: ThemeName = loadSavedDefaultTheme()): ParsedCliArgs {
  let target = process.cwd();
  let hasTarget = false;
  let printMode = false;
  let theme: ThemeName = defaultTheme;
  let viewMode: ViewMode | undefined;
  let width: number | undefined;
  let showHidden = false;
  let singleFile = false;
  let showHelp = false;
  let showVersion = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '-h' || arg === '--help') {
      showHelp = true;
    } else if (arg === '-v' || arg === '--version') {
      showVersion = true;
    } else if (arg === '-p' || arg === '--print' || arg === '--view') {
      printMode = true;
    } else if (arg === '-a' || arg === '--all') {
      showHidden = true;
    } else if (arg === '--single') {
      singleFile = true;
    } else if ((arg === '-t' || arg === '--theme') && argv[i + 1]) {
      theme = getTheme(argv[++i]).name;
    } else if ((arg === '-m' || arg === '--mode') && argv[i + 1]) {
      const candidate = (argv[++i] ?? '').toLowerCase() as ViewMode;
      if (VALID_MODES.has(candidate)) viewMode = candidate;
    } else if ((arg === '-w' || arg === '--width') && argv[i + 1]) {
      const parsed = Number.parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(parsed) && parsed >= 30) width = parsed;
    } else if (!arg.startsWith('-') && !hasTarget) {
      target = arg;
      hasTarget = true;
    }
  }

  return { target, printMode, theme, viewMode, width, showHidden, singleFile, showHelp, showVersion };
}

export function getHelpText(theme: ThemePalette = getTheme(loadSavedDefaultTheme())): string {
  const h = (title: string): string => `${fg(theme.accentAlt)}${BOLD}▌ ${title}${RESET}`;
  const cmd = (text: string): string => `${fg(theme.accent)}${BOLD}${text}${RESET}`;
  const dim = (text: string): string => `${fg(theme.muted)}${DIM}${text}${RESET}`;
  const txt = (text: string): string => `${fg(theme.text)}${text}${RESET}`;

  return [
    `${fg(theme.accent)}${BOLD}╔══════════════════════════════════════════════════════════════════════╗${RESET}`,
    `${fg(theme.accent)}${BOLD}║ ◈ EXPLOREIO v${VERSION} — Explorador de Terminal & Leitor Rico Nativo    ║${RESET}`,
    `${fg(theme.accent)}${BOLD}╚══════════════════════════════════════════════════════════════════════╝${RESET}`,
    txt('Navegação 3 colunas estilo Yazi + abertura e leitura rica direto no prompt.'),
    '',
    h('FORMAS DE ABRIR'),
    `  ${cmd('exploreio')}                         ${txt('Abre a TUI de 3 colunas (Pai | Atual | Preview Rico) aqui')}`,
    `  ${cmd('exploreio <pasta>')}                 ${txt('Abre a TUI diretamente em outro diretório')}`,
    `  ${cmd('exploreio <arquivo>')}               ${txt('Abre o arquivo direto no Leitor Fullscreen interativo')}`,
    `  ${cmd('exploreio -p <arquivo>')}            ${txt('Imprime formatado direto no prompt (stdout) e sai')}`,
    `  ${cmd('exp ...')}                           ${dim('Atalho curto idêntico a exploreio')}`,
    '',
    h('FORMATOS COM RENDERIZAÇÃO RICA (Tab alterna o modo no Leitor)'),
    `  ${cmd('Markdown (.md/.mdx)')}  ${txt('Títulos, tabelas, callouts, código e Mermaid inline')}     ${dim('[rendered | raw]')}`,
    `  ${cmd('Mermaid (.mmd)')}       ${txt('Diagramas 2D via @leosdc/termaid (flow/seq/state/er/timeline/git)')} ${dim('[rendered | raw]')}`,
    `  ${cmd('JSON (.json/.jsonc)')}  ${txt('Árvore interativa recolhível/expansível + diagnóstico')}   ${dim('[tree | pretty]')}`,
    `  ${cmd('HTML (.html/.htm)')}    ${txt('Modo Reader limpo (sem scripts/styles) + fonte colorido')} ${dim('[reader | source]')}`,
    `  ${cmd('Código-Fonte')}         ${txt('Syntax highlighting (TS/JS/Py/Rust/Go/CSS/SQL/YAML/Sh)')}  ${dim('[code]')}`,
    `  ${cmd('Binários')}             ${txt('Assinatura detectada (PNG/PDF/ZIP/WASM/EXE) + Hex Dump')}  ${dim('[hex]')}`,
    '',
    h('OPÇÕES DE LINHA DE COMANDO'),
    `  ${cmd('-p, --print, --view')}               ${txt('Renderiza o arquivo direto no stdout (estilo glow/bat/jq)')}`,
    `  ${cmd('-m, --mode <modo>')}                 ${txt('rendered | raw | tree | pretty | reader | source')}`,
    `  ${cmd('-t, --theme <tema>')}                ${txt('midnight (escuro) | parchment (claro) | nord (ártico)')}`,
    `  ${cmd('-w, --width <colunas>')}             ${txt('Largura máxima de renderização no modo --print')}`,
    `  ${cmd('-a, --all')}                         ${txt('Exibe arquivos ocultos (iniciados por ".") ao abrir')}`,
    `  ${cmd('--single')}                          ${txt('Abre o arquivo direto no Leitor e fecha ao pressionar Esc/q')}`,
    `  ${cmd('-v, --version')}                     ${txt('Exibe a versão instalada')}`,
    `  ${cmd('-h, --help')}                        ${txt('Exibe este guia de uso')}`,
    '',
    h('ATALHOS ESSENCIAIS NA TUI'),
    `  ${cmd('↑/↓ ou j/k')}  Mover (roda do mouse)      ${cmd('Enter / →')}  Entrar na pasta ou ABRIR no Leitor`,
    `  ${cmd('← / Bksp')}    Subir diretório            ${cmd('Tab')}        Alternar modo (Rendered↔Raw / Tree↔Pretty)`,
    `  ${cmd('o / F')}       Abrir em shell Fullscreen  ${cmd('e')}          Abrir no Editor Vim nativo`,
    `  ${cmd('/ ou f')}      Filtrar / Buscar (n/N)     ${cmd('t')}          Trocar tema (Midnight · Parchment · Nord)`,
    `  ${cmd('e / c')}       Expandir/Recolher JSON     ${cmd('a / r / d')}  Criar / Renomear / Excluir arquivo`,
    `  ${cmd('y')}           Copiar caminho (path)      ${cmd('.')}          Alternar arquivos ocultos`,
    `  ${cmd('?')}           Ajuda completa             ${cmd('Esc / q')}    Voltar ou Sair`,
    '',
    h('EXEMPLOS PRÁTICOS'),
    `  ${cmd('exploreio')}                                ${dim('# Navegador 3 colunas na pasta atual')}`,
    `  ${cmd('exploreio README.md')}                      ${dim('# Abre README.md no Leitor Fullscreen')}`,
    `  ${cmd('exp -p package.json -m tree -t nord')}      ${dim('# Árvore JSON colorida direto no prompt')}`,
    `  ${cmd('exp -p index.html -m reader -t parchment')} ${dim('# HTML legível em tema claro no prompt')}`,
  ].join('\n');
}

export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const args = parseCliArgs(argv);

  if (args.showHelp) {
    process.stdout.write(`${getHelpText(getTheme(args.theme))}\n`);
    return 0;
  }
  if (args.showVersion) {
    process.stdout.write(`exploreio v${VERSION}\n`);
    return 0;
  }

  const resolvedTarget = path.resolve(args.target);
  let isFile = false;
  try {
    const stat = await fs.stat(resolvedTarget);
    isFile = stat.isFile();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Exploreio: caminho não encontrado (${resolvedTarget}) — ${msg}\n`);
    return 1;
  }

  if (args.printMode) {
    if (!isFile) {
      process.stderr.write('Exploreio: o modo --print exige um arquivo (ex.: exploreio -p README.md).\n');
      return 1;
    }
    const preview = await safeReadFilePreview(resolvedTarget);
    const theme = getTheme(args.theme);
    const width = args.width ?? Math.max(50, Math.min(120, process.stdout.columns || 92));
    const doc = renderDocument(preview, { width, theme, preferredMode: args.viewMode });
    process.stdout.write(`${doc.lines.join('\n')}\n`);
    return 0;
  }

  const app = new ExploreioApp({
    startDir: isFile ? path.dirname(resolvedTarget) : resolvedTarget,
    initialFile: isFile ? resolvedTarget : undefined,
    initialMode: args.viewMode,
    singleFile: isFile && args.singleFile,
    themeName: args.theme,
    showHidden: args.showHidden,
  });

  await app.start(isFile ? resolvedTarget : undefined);
  return 0;
}

function isDirectExecution(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    const currentFile = realpathSync(fileURLToPath(import.meta.url));
    const invokedFile = realpathSync(path.resolve(invoked));
    return currentFile.toLowerCase() === invokedFile.toLowerCase();
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  runCli().then((code) => {
    if (code !== 0) process.exit(code);
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Exploreio erro fatal: ${msg}\n`);
    process.exit(1);
  });
}

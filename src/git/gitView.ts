/**
 * Exploreio Git & GitHub Panel TUI Renderer (SPEC-005)
 * Renderiza o painel dedicado (Status + Commits Parados, Árvore de Commits,
 * Branches, GitHub PRs/Issues/Actions), barra de botões rápidos e paleta
 * interativa `?` respeitando os 3 temas oficiais (midnight, parchment, nord).
 */

import { bg, fg, type RgbColor, type ThemePalette } from '../themes/palette.js';
import { BOLD, DIM, ITALIC, RESET, fitAnsi, stripUnsafeAnsi, truncateAnsi, visibleLength } from '../tui/ansi.js';
import type {
  CommitGraphRow,
  GitBranchInfo,
  GitHeaderSummary,
  GitHubIssue,
  GitHubPanelData,
  GitHubPullRequest,
  GitHubWorkflowRun,
  GitPanelSnapshot,
  GitStatusEntry,
  UnpushedCommit,
} from './gitService.js';

export type GitPanelTab = 'status' | 'graph' | 'branches' | 'github';

export type GitQuickActionId =
  | 'pull'
  | 'push'
  | 'fetch'
  | 'commit'
  | 'create-branch'
  | 'goto-branches'
  | 'stage-all'
  | 'stash-push'
  | 'stash-pop';

export interface GitQuickActionItem {
  readonly id: GitQuickActionId;
  readonly hotkey: string;
  readonly label: string;
  readonly command: string;
  readonly detail: string;
}

export type StatusListItem =
  | { readonly kind: 'header'; readonly title: string; readonly color: 'warning' | 'success' | 'danger' | 'accent' | 'muted' }
  | { readonly kind: 'unpushed'; readonly commit: UnpushedCommit }
  | { readonly kind: 'file'; readonly entry: GitStatusEntry };

export type GitHubListItem =
  | { readonly kind: 'header'; readonly title: string }
  | { readonly kind: 'pr'; readonly pr: GitHubPullRequest }
  | { readonly kind: 'issue'; readonly issue: GitHubIssue }
  | { readonly kind: 'run'; readonly run: GitHubWorkflowRun };

export interface GitPanelViewState {
  readonly snapshot: GitPanelSnapshot;
  readonly github: GitHubPanelData;
  readonly activeTab: GitPanelTab;
  readonly selectedIndex: number;
  readonly listScroll: number;
  readonly detailTitle: string;
  readonly detailLines: string[];
  readonly detailScroll: number;
  readonly showQuickPalette: boolean;
  readonly quickPaletteIndex: number;
  readonly busyMessage: string;
  readonly footerLine: string;
}

/** Constrói a lista linear da aba Status (Commits Parados + Conflitos + Staged + Modificados + Untracked). */
export function buildStatusListItems(snapshot: GitPanelSnapshot): StatusListItem[] {
  const items: StatusListItem[] = [];

  if (snapshot.unpushedCommits.length > 0) {
    items.push({
      kind: 'header',
      title: `▲ COMMITS PARADOS (${snapshot.unpushedCommits.length} aguardando push)`,
      color: 'warning',
    });
    for (const commit of snapshot.unpushedCommits) {
      items.push({ kind: 'unpushed', commit });
    }
  }

  const conflicted = snapshot.status.entries.filter((e) => e.section === 'conflicted');
  const staged = snapshot.status.entries.filter((e) => e.section === 'staged');
  const unstaged = snapshot.status.entries.filter((e) => e.section === 'unstaged');
  const untracked = snapshot.status.entries.filter((e) => e.section === 'untracked');

  if (conflicted.length > 0) {
    items.push({ kind: 'header', title: `! CONFLITOS (${conflicted.length})`, color: 'danger' });
    for (const entry of conflicted) items.push({ kind: 'file', entry });
  }
  if (staged.length > 0) {
    items.push({ kind: 'header', title: `● STAGED (${staged.length} prontos para commit)`, color: 'success' });
    for (const entry of staged) items.push({ kind: 'file', entry });
  }
  if (unstaged.length > 0) {
    items.push({ kind: 'header', title: `○ MODIFICADOS (${unstaged.length})`, color: 'warning' });
    for (const entry of unstaged) items.push({ kind: 'file', entry });
  }
  if (untracked.length > 0) {
    items.push({ kind: 'header', title: `? NÃO RASTREADOS (${untracked.length})`, color: 'muted' });
    for (const entry of untracked) items.push({ kind: 'file', entry });
  }

  return items;
}

/** Constrói a lista linear da aba GitHub (PRs + Issues + Workflow Runs). */
export function buildGitHubListItems(github: GitHubPanelData): GitHubListItem[] {
  if (!github.available) return [];
  const items: GitHubListItem[] = [];

  items.push({ kind: 'header', title: `⎇ PULL REQUESTS ABERTOS (${github.pullRequests.length})` });
  for (const pr of github.pullRequests) items.push({ kind: 'pr', pr });

  items.push({ kind: 'header', title: `◎ ISSUES ABERTAS (${github.issues.length})` });
  for (const issue of github.issues) items.push({ kind: 'issue', issue });

  items.push({ kind: 'header', title: `⚡ GITHUB ACTIONS (${github.workflowRuns.length})` });
  for (const run of github.workflowRuns) items.push({ kind: 'run', run });

  return items;
}

/** Retorna a lista contextual de comandos rápidos da paleta `?` identificando o repositório. */
export function buildQuickActions(snapshot: GitPanelSnapshot): GitQuickActionItem[] {
  const aheadHint =
    snapshot.unpushedCommits.length > 0
      ? `${snapshot.unpushedCommits.length} commit(s) parado(s)`
      : 'sincronizado';
  const behindHint = snapshot.status.behind > 0 ? `${snapshot.status.behind} atrás` : 'atualizado';
  const stagedHint = `${snapshot.status.stagedCount} staged`;
  const dirtyTotal =
    snapshot.status.stagedCount + snapshot.status.unstagedCount + snapshot.status.untrackedCount;

  return [
    {
      id: 'pull',
      hotkey: '1',
      label: 'Pull da branch atual',
      command: 'git pull --ff-only',
      detail: behindHint,
    },
    {
      id: 'push',
      hotkey: '2',
      label: 'Push dos commits parados',
      command: snapshot.status.upstream ? 'git push' : `git push -u origin ${snapshot.status.branch}`,
      detail: aheadHint,
    },
    {
      id: 'fetch',
      hotkey: '3',
      label: 'Fetch remoto (prune)',
      command: 'git fetch --all --prune',
      detail: 'atualiza refs',
    },
    {
      id: 'commit',
      hotkey: '4',
      label: 'Criar commit',
      command: 'git commit -m "..."',
      detail: stagedHint,
    },
    {
      id: 'create-branch',
      hotkey: '5',
      label: 'Criar nova branch',
      command: 'git checkout -b <nome>',
      detail: `base: ${snapshot.status.branch || 'HEAD'}`,
    },
    {
      id: 'goto-branches',
      hotkey: '6',
      label: 'Trocar de branch',
      command: 'git branch / checkout',
      detail: `${snapshot.branches.length} branch(es)`,
    },
    {
      id: 'stage-all',
      hotkey: '7',
      label: 'Stage de todas alterações',
      command: 'git add -A',
      detail: `${dirtyTotal} pendente(s)`,
    },
    {
      id: 'stash-push',
      hotkey: '8',
      label: 'Guardar no Stash',
      command: 'git stash push -u',
      detail: `${dirtyTotal} alteração(ões)`,
    },
    {
      id: 'stash-pop',
      hotkey: '9',
      label: 'Restaurar último Stash',
      command: 'git stash pop',
      detail: `${snapshot.stashCount} stash(es)`,
    },
  ];
}

/** Formata o badge discreto de Git para o cabeçalho do Navegador principal. */
export function formatGitHeaderBadge(summary: GitHeaderSummary | null, theme: ThemePalette): string {
  if (!summary) return '';
  const parts: string[] = [`${bg(theme.headerBg)}${fg(theme.accentAlt)}${BOLD} ⎇ ${truncateAnsi(summary.branch, 22)}${RESET}`];
  if (summary.ahead > 0) {
    parts.push(`${bg(theme.headerBg)}${fg(theme.warning)}${BOLD} ↑${summary.ahead}${RESET}`);
  }
  if (summary.behind > 0) {
    parts.push(`${bg(theme.headerBg)}${fg(theme.accent)}${BOLD} ↓${summary.behind}${RESET}`);
  }
  if (summary.dirtyCount > 0) {
    parts.push(`${bg(theme.headerBg)}${fg(theme.success)} ●${summary.dirtyCount}${RESET}`);
  }
  parts.push(`${bg(theme.headerBg)} ${RESET}`);
  return parts.join('');
}

/** Coloriza uma linha de diff ou `git show` respeitando o tema ativo. */
export function styleDiffLine(rawLine: string, theme: ThemePalette): string {
  const line = stripUnsafeAnsi(rawLine);
  if (line.startsWith('+++') || line.startsWith('---')) {
    return `${fg(theme.accent)}${BOLD}${line}${RESET}`;
  }
  if (line.startsWith('@@')) {
    return `${fg(theme.accentAlt)}${BOLD}${line}${RESET}`;
  }
  if (line.startsWith('+')) {
    return `${fg(theme.success)}${line}${RESET}`;
  }
  if (line.startsWith('-')) {
    return `${fg(theme.danger)}${line}${RESET}`;
  }
  if (line.startsWith('diff --git ') || line.startsWith('commit ')) {
    return `${fg(theme.warning)}${BOLD}${line}${RESET}`;
  }
  if (line.startsWith('Author:') || line.startsWith('Date:')) {
    return `${fg(theme.muted)}${line}${RESET}`;
  }
  return `${fg(theme.text)}${line}${RESET}`;
}

/** Estiliza o prefixo ASCII de `git log --graph` com trilhos Unicode e cores do tema. */
function styleGraphPrefix(prefix: string, isUnpushed: boolean, theme: ThemePalette): string {
  const laneColors: readonly RgbColor[] = [
    theme.accent,
    theme.accentAlt,
    theme.success,
    theme.warning,
    theme.dir,
    theme.syntaxOperator,
  ];
  let out = '';
  for (let i = 0; i < prefix.length; i++) {
    const ch = prefix[i] ?? ' ';
    const color = laneColors[Math.floor(i / 2) % laneColors.length] ?? theme.accent;
    if (ch === '*') {
      out += `${fg(isUnpushed ? theme.warning : theme.accent)}${BOLD}●${RESET}`;
    } else if (ch === '|') {
      out += `${fg(color)}│${RESET}`;
    } else if (ch === '/') {
      out += `${fg(color)}╱${RESET}`;
    } else if (ch === '\\') {
      out += `${fg(color)}╲${RESET}`;
    } else if (ch === '_') {
      out += `${fg(color)}─${RESET}`;
    } else {
      out += ch;
    }
  }
  return out;
}

function renderStatusRow(
  item: StatusListItem,
  selected: boolean,
  width: number,
  theme: ThemePalette
): string {
  if (item.kind === 'header') {
    const color =
      item.color === 'warning'
        ? theme.warning
        : item.color === 'success'
          ? theme.success
          : item.color === 'danger'
            ? theme.danger
            : item.color === 'accent'
              ? theme.accent
              : theme.muted;
    return fitAnsi(` ${fg(color)}${BOLD}${item.title}${RESET}`, width);
  }

  if (item.kind === 'unpushed') {
    const c = item.commit;
    if (selected) {
      const inner = ` ▸ ↑ ${c.shortHash} ${c.subject}`;
      return `${bg(theme.selectionBg)}${fg(theme.selectionFg)}${BOLD}${fitAnsi(inner, width)}${RESET}`;
    }
    const line = `   ${fg(theme.warning)}${BOLD}↑${RESET} ${fg(theme.syntaxNumber)}${c.shortHash}${RESET} ${fg(theme.text)}${c.subject}${RESET} ${fg(theme.muted)}${DIM}${c.relativeDate}${RESET}`;
    return fitAnsi(line, width);
  }

  const e = item.entry;
  const badgeColor =
    e.section === 'staged'
      ? theme.success
      : e.section === 'conflicted'
        ? theme.danger
        : e.section === 'unstaged'
          ? theme.warning
          : theme.muted;
  const displayPath = e.origPath ? `${e.origPath} → ${e.path}` : e.path;
  if (selected) {
    const inner = ` ▸ [${e.label}] ${displayPath}`;
    return `${bg(theme.selectionBg)}${fg(theme.selectionFg)}${BOLD}${fitAnsi(inner, width)}${RESET}`;
  }
  const line = `   ${fg(badgeColor)}${BOLD}[${e.label}]${RESET} ${fg(theme.text)}${displayPath}${RESET}`;
  return fitAnsi(line, width);
}

function renderGraphRow(
  row: CommitGraphRow,
  selected: boolean,
  width: number,
  theme: ThemePalette
): string {
  const graphPart = styleGraphPrefix(row.graphPrefix, row.isUnpushed, theme);
  if (row.isConnectorOnly) {
    return fitAnsi(` ${graphPart}`, width);
  }

  const unpushedTag = row.isUnpushed ? `${fg(theme.warning)}${BOLD}↑${RESET}` : '';
  const refsTag =
    row.refs.length > 0
      ? ` ${fg(theme.accentAlt)}${BOLD}(${truncateAnsi(row.refs.join(', '), 24)})${RESET}`
      : '';

  if (selected) {
    const plainRefs = row.refs.length > 0 ? ` (${row.refs.join(', ')})` : '';
    const inner = ` ▸ ${row.isUnpushed ? '↑ ' : ''}${row.shortHash}${plainRefs} ${row.subject}`;
    return `${bg(theme.selectionBg)}${fg(theme.selectionFg)}${BOLD}${fitAnsi(inner, width)}${RESET}`;
  }

  const line = ` ${graphPart}${unpushedTag}${fg(theme.syntaxNumber)}${row.shortHash}${RESET}${refsTag} ${fg(theme.text)}${row.subject}${RESET} ${fg(theme.muted)}${DIM}${row.relativeDate}${RESET}`;
  return fitAnsi(line, width);
}

function renderBranchRow(
  branch: GitBranchInfo,
  selected: boolean,
  width: number,
  theme: ThemePalette
): string {
  const mark = branch.isCurrent ? '*' : branch.isRemote ? '◇' : ' ';
  const track = branch.track ? ` ${branch.track}` : '';
  if (selected) {
    const inner = ` ▸ ${mark} ${branch.name}${track}`;
    return `${bg(theme.selectionBg)}${fg(theme.selectionFg)}${BOLD}${fitAnsi(inner, width)}${RESET}`;
  }
  const nameColor = branch.isCurrent ? theme.success : branch.isRemote ? theme.muted : theme.text;
  const trackStyled = branch.track ? ` ${fg(theme.warning)}${branch.track}${RESET}` : '';
  const line = `  ${fg(branch.isCurrent ? theme.success : theme.muted)}${BOLD}${mark}${RESET} ${fg(nameColor)}${branch.isCurrent ? BOLD : ''}${branch.name}${RESET}${trackStyled} ${fg(theme.muted)}${DIM}${branch.relativeDate}${RESET}`;
  return fitAnsi(line, width);
}

function renderGitHubRow(
  item: GitHubListItem,
  selected: boolean,
  width: number,
  theme: ThemePalette
): string {
  if (item.kind === 'header') {
    return fitAnsi(` ${fg(theme.accentAlt)}${BOLD}${item.title}${RESET}`, width);
  }
  if (item.kind === 'pr') {
    const pr = item.pr;
    const draft = pr.isDraft ? '[DRAFT] ' : '';
    if (selected) {
      return `${bg(theme.selectionBg)}${fg(theme.selectionFg)}${BOLD}${fitAnsi(` ▸ #${pr.number} ${draft}${pr.title}`, width)}${RESET}`;
    }
    return fitAnsi(
      `   ${fg(theme.success)}${BOLD}#${pr.number}${RESET} ${pr.isDraft ? `${fg(theme.muted)}[DRAFT] ${RESET}` : ''}${fg(theme.text)}${pr.title}${RESET} ${fg(theme.muted)}${DIM}@${pr.author}${RESET}`,
      width
    );
  }
  if (item.kind === 'issue') {
    const issue = item.issue;
    if (selected) {
      return `${bg(theme.selectionBg)}${fg(theme.selectionFg)}${BOLD}${fitAnsi(` ▸ #${issue.number} ${issue.title}`, width)}${RESET}`;
    }
    return fitAnsi(
      `   ${fg(theme.warning)}${BOLD}#${issue.number}${RESET} ${fg(theme.text)}${issue.title}${RESET} ${fg(theme.muted)}${DIM}@${issue.author}${RESET}`,
      width
    );
  }
  const run = item.run;
  const icon =
    run.conclusion === 'success'
      ? `${fg(theme.success)}✓${RESET}`
      : run.conclusion === 'failure'
        ? `${fg(theme.danger)}✗${RESET}`
        : `${fg(theme.warning)}⟳${RESET}`;
  if (selected) {
    return `${bg(theme.selectionBg)}${fg(theme.selectionFg)}${BOLD}${fitAnsi(` ▸ ${run.workflowName}: ${run.title}`, width)}${RESET}`;
  }
  return fitAnsi(
    `   ${icon} ${fg(theme.accent)}${run.workflowName}${RESET} ${fg(theme.text)}${run.title}${RESET} ${fg(theme.muted)}${DIM}(${run.branch})${RESET}`,
    width
  );
}

/** Constrói o frame completo (altura x largura) do Painel Git & GitHub. */
export function buildGitPanelFrame(
  state: GitPanelViewState,
  width: number,
  height: number,
  theme: ThemePalette
): string[] {
  const { snapshot, github, activeTab } = state;

  // Linha 1: Cabeçalho com identidade do repositório e contadores
  const brand = `${bg(theme.headerBg)}${fg(theme.accent)}${BOLD} ◈ GIT / GITHUB ${RESET}`;
  const repoId = snapshot.githubRepo ?? snapshot.repoName;
  const branchBadge = snapshot.isGitRepo
    ? `${bg(theme.headerBg)}${fg(theme.accentAlt)}${BOLD} ⎇ ${snapshot.status.branch} ${RESET}`
    : '';
  const aheadBadge =
    snapshot.unpushedCommits.length > 0
      ? `${bg(theme.headerBg)}${fg(theme.warning)}${BOLD}↑${snapshot.unpushedCommits.length} parado(s) ${RESET}`
      : '';
  const behindBadge =
    snapshot.status.behind > 0
      ? `${bg(theme.headerBg)}${fg(theme.accent)}${BOLD}↓${snapshot.status.behind} ${RESET}`
      : '';
  const themePill = `${bg(theme.headerBg)}${fg(theme.muted)} [${theme.label}] ${RESET}`;
  const repoMax = Math.max(
    8,
    width -
      visibleLength(brand) -
      visibleLength(branchBadge) -
      visibleLength(aheadBadge) -
      visibleLength(behindBadge) -
      visibleLength(themePill) -
      2
  );
  const repoLabel = `${bg(theme.headerBg)}${fg(theme.headerFg)}${BOLD} ${truncateAnsi(repoId, repoMax)} ${RESET}`;
  const headerUsed =
    visibleLength(brand) +
    visibleLength(repoLabel) +
    visibleLength(branchBadge) +
    visibleLength(aheadBadge) +
    visibleLength(behindBadge) +
    visibleLength(themePill);
  const headerFill = `${bg(theme.headerBg)}${' '.repeat(Math.max(0, width - headerUsed))}${RESET}`;
  const headerLine = `${brand}${repoLabel}${branchBadge}${aheadBadge}${behindBadge}${headerFill}${themePill}`;

  // Linha 2: Abas + Barra de Botões Rápidos
  const pendingCount =
    snapshot.unpushedCommits.length +
    snapshot.status.stagedCount +
    snapshot.status.unstagedCount +
    snapshot.status.untrackedCount;
  const tabDefs: Array<{ id: GitPanelTab; label: string }> = [
    { id: 'status', label: `1 Status${pendingCount > 0 ? ` (${pendingCount})` : ''}` },
    { id: 'graph', label: '2 Árvore' },
    { id: 'branches', label: `3 Branches (${snapshot.branches.length})` },
    { id: 'github', label: '4 GitHub' },
  ];
  const tabsStr = tabDefs
    .map((t) =>
      t.id === activeTab
        ? `${bg(theme.selectionBg)}${fg(theme.selectionFg)}${BOLD} ${t.label} ${RESET}`
        : `${bg(theme.statusBg)}${fg(theme.muted)} ${t.label} ${RESET}`
    )
    .join(`${bg(theme.statusBg)}${fg(theme.border)}│${RESET}`);

  const quickButtons = snapshot.isGitRepo
    ? `${bg(theme.statusBg)} ${fg(theme.accent)}[s]${fg(theme.statusFg)}Stage ${fg(theme.accent)}[c]${fg(theme.statusFg)}Commit ${fg(theme.accent)}[p]${fg(theme.statusFg)}Pull ${fg(theme.accent)}[P]${fg(theme.statusFg)}Push ${fg(theme.accent)}[b]${fg(theme.statusFg)}Branch ${fg(theme.warning)}${BOLD}[?]Ações ${RESET}`
    : '';
  const tabLinePad = Math.max(0, width - visibleLength(tabsStr) - visibleLength(quickButtons));
  const subHeaderLine =
    visibleLength(tabsStr) + visibleLength(quickButtons) <= width
      ? `${tabsStr}${bg(theme.statusBg)}${' '.repeat(tabLinePad)}${RESET}${quickButtons}`
      : fitAnsi(`${bg(theme.statusBg)}${tabsStr}`, width);

  const bodyHeight = Math.max(4, height - 3);
  const rows: string[] = [headerLine, subHeaderLine];

  if (!snapshot.isGitRepo) {
    for (let r = 0; r < bodyHeight; r++) {
      if (r === 1) {
        rows.push(fitAnsi(`  ${fg(theme.warning)}${BOLD}◆ ${snapshot.error ?? 'Não é um repositório Git.'}${RESET}`, width));
      } else if (r === 3) {
        rows.push(
          fitAnsi(
            `  ${fg(theme.muted)}Navegue até uma pasta com repositório Git e pressione Tab ou Ctrl+G.${RESET}`,
            width
          )
        );
      } else {
        rows.push(' '.repeat(width));
      }
    }
    rows.push(state.footerLine);
    return rows;
  }

  const useSplit = width >= 88;
  const leftW = useSplit ? Math.max(36, Math.floor(width * 0.48)) : width;
  const rightW = useSplit ? Math.max(0, width - leftW - 1) : 0;
  const sep = `${fg(theme.border)}│${RESET}`;

  // Constrói linhas do painel esquerdo conforme a aba ativa
  const leftRows: string[] = [];
  if (activeTab === 'status') {
    const items = buildStatusListItems(snapshot);
    if (items.length === 0) {
      leftRows.push(fitAnsi(` ${fg(theme.success)}${BOLD}✓ Working tree limpo${RESET}`, leftW));
      leftRows.push(
        fitAnsi(
          ` ${fg(theme.muted)}Sem arquivos pendentes e sem commits parados na branch ${snapshot.status.branch}.${RESET}`,
          leftW
        )
      );
    } else {
      for (let i = 0; i < bodyHeight; i++) {
        const idx = state.listScroll + i;
        const item = items[idx];
        leftRows.push(item ? renderStatusRow(item, idx === state.selectedIndex, leftW, theme) : ' '.repeat(leftW));
      }
    }
  } else if (activeTab === 'graph') {
    if (snapshot.commitGraph.length === 0) {
      leftRows.push(fitAnsi(` ${fg(theme.muted)}${ITALIC}(nenhum commit encontrado neste repositório)${RESET}`, leftW));
    } else {
      for (let i = 0; i < bodyHeight; i++) {
        const idx = state.listScroll + i;
        const row = snapshot.commitGraph[idx];
        leftRows.push(row ? renderGraphRow(row, idx === state.selectedIndex, leftW, theme) : ' '.repeat(leftW));
      }
    }
  } else if (activeTab === 'branches') {
    if (snapshot.branches.length === 0) {
      leftRows.push(fitAnsi(` ${fg(theme.muted)}${ITALIC}(nenhuma branch encontrada)${RESET}`, leftW));
    } else {
      for (let i = 0; i < bodyHeight; i++) {
        const idx = state.listScroll + i;
        const br = snapshot.branches[idx];
        leftRows.push(br ? renderBranchRow(br, idx === state.selectedIndex, leftW, theme) : ' '.repeat(leftW));
      }
    }
  } else {
    if (github.loading) {
      leftRows.push(fitAnsi(` ${fg(theme.accent)}⟳ Consultando GitHub via gh CLI...${RESET}`, leftW));
    } else if (!github.available) {
      leftRows.push(fitAnsi(` ${fg(theme.warning)}${BOLD}◆ GitHub indisponível${RESET}`, leftW));
      leftRows.push(fitAnsi(` ${fg(theme.muted)}${github.reason ?? 'Verifique o gh CLI.'}${RESET}`, leftW));
    } else {
      const items = buildGitHubListItems(github);
      for (let i = 0; i < bodyHeight; i++) {
        const idx = state.listScroll + i;
        const item = items[idx];
        leftRows.push(item ? renderGitHubRow(item, idx === state.selectedIndex, leftW, theme) : ' '.repeat(leftW));
      }
    }
  }

  for (let r = 0; r < bodyHeight; r++) {
    const leftCell = leftRows[r] ?? ' '.repeat(leftW);
    if (!useSplit || rightW <= 0) {
      rows.push(leftCell);
      continue;
    }

    let rightCell: string;
    if (r === 0) {
      const title = state.busyMessage
        ? `${fg(theme.warning)}${BOLD} ⟳ ${state.busyMessage}${RESET}`
        : `${fg(theme.accentAlt)}${BOLD} ${state.detailTitle || 'Detalhes & Diff'}${RESET}`;
      rightCell = fitAnsi(title, rightW);
    } else {
      const lineIdx = state.detailScroll + (r - 1);
      const rawLine = state.detailLines[lineIdx];
      rightCell = rawLine !== undefined ? fitAnsi(` ${styleDiffLine(rawLine, theme)}`, rightW) : ' '.repeat(rightW);
    }
    rows.push(`${leftCell}${sep}${rightCell}`);
  }

  rows.push(state.footerLine);

  if (state.showQuickPalette) {
    overlayQuickPalette(rows, state, width, height, theme);
  }

  return rows;
}

function overlayQuickPalette(
  lines: string[],
  state: GitPanelViewState,
  width: number,
  height: number,
  theme: ThemePalette
): void {
  const actions = buildQuickActions(state.snapshot);
  const boxW = Math.min(76, Math.max(40, width - 4));
  const innerW = boxW - 2;
  const padLeft = ' '.repeat(Math.max(0, Math.floor((width - boxW) / 2)));

  const repoSlug = state.snapshot.githubRepo ?? state.snapshot.repoName;
  const repoMeta = ` Repo: ${repoSlug} · ⎇ ${state.snapshot.status.branch} · ↑${state.snapshot.unpushedCommits.length} ↓${state.snapshot.status.behind} ●${state.snapshot.status.stagedCount + state.snapshot.status.unstagedCount + state.snapshot.status.untrackedCount}`;

  const modalLines: string[] = [
    `${padLeft}${fg(theme.borderActive)}${BOLD}╭${'─'.repeat(innerW)}╮${RESET}`,
    `${padLeft}${fg(theme.borderActive)}${BOLD}│${bg(theme.headerBg)}${fg(theme.accent)}${fitAnsi('  ◈ COMANDOS RÁPIDOS GIT / GITHUB (1-9 ou ↑↓ + Enter · Esc fecha)', innerW)}${RESET}${fg(theme.borderActive)}${BOLD}│${RESET}`,
    `${padLeft}${fg(theme.borderActive)}│${bg(theme.statusBg)}${fg(theme.accentAlt)}${BOLD}${fitAnsi(repoMeta, innerW)}${RESET}${fg(theme.borderActive)}│${RESET}`,
    `${padLeft}${fg(theme.borderActive)}├${'─'.repeat(innerW)}┤${RESET}`,
  ];

  actions.forEach((act, idx) => {
    const selected = idx === state.quickPaletteIndex;
    const text = ` [${act.hotkey}] ${act.label.padEnd(26)} ${act.command.padEnd(24)} (${act.detail})`;
    if (selected) {
      modalLines.push(
        `${padLeft}${fg(theme.borderActive)}│${bg(theme.selectionBg)}${fg(theme.selectionFg)}${BOLD}${fitAnsi(`▸${text}`, innerW)}${RESET}${fg(theme.borderActive)}│${RESET}`
      );
    } else {
      modalLines.push(
        `${padLeft}${fg(theme.borderActive)}│${bg(theme.statusBg)}${fg(theme.text)}${fitAnsi(` ${text}`, innerW)}${RESET}${fg(theme.borderActive)}│${RESET}`
      );
    }
  });

  modalLines.push(`${padLeft}${fg(theme.borderActive)}${BOLD}╰${'─'.repeat(innerW)}╯${RESET}`);

  const startRow = Math.max(1, Math.floor((height - modalLines.length) / 2));
  modalLines.forEach((mLine, offset) => {
    const targetRow = startRow + offset;
    if (targetRow >= 0 && targetRow < lines.length) {
      lines[targetRow] = mLine;
    }
  });
}

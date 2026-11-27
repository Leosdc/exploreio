/**
 * Exploreio Git & GitHub Service (SPEC-005)
 * Cliente Git local e GitHub CLI (`gh`) seguro usando `execFile` (zero shell interpolation),
 * timeouts explícitos, limites anti-OOM e sanitização anti-ANSI-injection.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { stripUnsafeAnsi } from '../tui/ansi.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10_000;
const GIT_NETWORK_TIMEOUT_MS = 25_000;
const GH_TIMEOUT_MS = 8_000;
const MAX_EXEC_BUFFER = 1024 * 1024; // 1 MB
const MAX_PREVIEW_DIFF_LINES = 400;

export type GitFileSection = 'staged' | 'unstaged' | 'untracked' | 'conflicted';

export interface GitStatusEntry {
  readonly path: string;
  readonly origPath?: string;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
  readonly section: GitFileSection;
  readonly label: string;
}

export interface ParsedGitStatus {
  readonly branch: string;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly entries: GitStatusEntry[];
  readonly stagedCount: number;
  readonly unstagedCount: number;
  readonly untrackedCount: number;
  readonly conflictedCount: number;
}

export interface GitHeaderSummary {
  readonly repoRoot: string;
  readonly branch: string;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly stagedCount: number;
  readonly unstagedCount: number;
  readonly untrackedCount: number;
  readonly dirtyCount: number;
}

export interface UnpushedCommit {
  readonly shortHash: string;
  readonly fullHash: string;
  readonly relativeDate: string;
  readonly author: string;
  readonly subject: string;
}

export interface CommitGraphRow {
  readonly graphPrefix: string;
  readonly isConnectorOnly: boolean;
  readonly shortHash: string;
  readonly fullHash: string;
  readonly refs: string[];
  readonly author: string;
  readonly relativeDate: string;
  readonly subject: string;
  readonly isUnpushed: boolean;
}

export interface GitBranchInfo {
  readonly name: string;
  readonly isCurrent: boolean;
  readonly isRemote: boolean;
  readonly upstream: string;
  readonly track: string;
  readonly relativeDate: string;
  readonly subject: string;
}

export interface GitHubPullRequest {
  readonly number: number;
  readonly title: string;
  readonly author: string;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly isDraft: boolean;
  readonly reviewDecision: string;
  readonly updatedAt: string;
  readonly url: string;
}

export interface GitHubIssue {
  readonly number: number;
  readonly title: string;
  readonly author: string;
  readonly labels: string[];
  readonly updatedAt: string;
  readonly url: string;
}

export interface GitHubWorkflowRun {
  readonly id: number;
  readonly title: string;
  readonly workflowName: string;
  readonly branch: string;
  readonly status: string;
  readonly conclusion: string;
  readonly updatedAt: string;
  readonly url: string;
}

export interface GitHubPanelData {
  readonly available: boolean;
  readonly loading: boolean;
  readonly reason?: string;
  readonly repoSlug: string | null;
  readonly pullRequests: GitHubPullRequest[];
  readonly issues: GitHubIssue[];
  readonly workflowRuns: GitHubWorkflowRun[];
}

export interface GitPanelSnapshot {
  readonly isGitRepo: boolean;
  readonly repoRoot: string;
  readonly repoName: string;
  readonly remoteUrl: string | null;
  readonly githubRepo: string | null;
  readonly status: ParsedGitStatus;
  readonly unpushedCommits: UnpushedCommit[];
  readonly commitGraph: CommitGraphRow[];
  readonly branches: GitBranchInfo[];
  readonly stashCount: number;
  readonly error?: string;
}

export interface GitCommandResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly errorMessage?: string;
}

interface ExecResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

async function runBin(
  bin: string,
  args: readonly string[],
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, [...args], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_EXEC_BUFFER,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
      },
    });
    return { ok: true, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? e.message ?? 'Erro ao executar comando'),
    };
  }
}

/** Remove credenciais embutidas (user:token@) de URLs remotas antes de exibir na UI. */
export function sanitizeRemoteUrl(rawUrl: string): string {
  const clean = stripUnsafeAnsi(rawUrl.trim());
  return clean.replace(/(https?:\/\/)([^/@\s]+)@/i, '$1');
}

/** Extrai `owner/repo` de URLs remotas do GitHub (HTTPS ou SSH). */
export function parseGitHubRepoFromUrl(rawUrl: string): string | null {
  const clean = sanitizeRemoteUrl(rawUrl);
  const httpsMatch = clean.match(/^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (httpsMatch?.[1] && httpsMatch[2]) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
  }
  const sshMatch = clean.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (sshMatch?.[1] && sshMatch[2]) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }
  return null;
}

function statusCodeLabel(code: string): string {
  switch (code) {
    case 'M':
      return 'M';
    case 'A':
      return 'A';
    case 'D':
      return 'D';
    case 'R':
      return 'R';
    case 'C':
      return 'C';
    case 'U':
      return 'U';
    case '?':
      return '?';
    default:
      return code || '·';
  }
}

/** Parser puro de `git status --porcelain=v2 --branch`. */
export function parsePorcelainV2Status(stdout: string): ParsedGitStatus {
  let branch = '(detached)';
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;

  const staged: GitStatusEntry[] = [];
  const unstaged: GitStatusEntry[] = [];
  const untracked: GitStatusEntry[] = [];
  const conflicted: GitStatusEntry[] = [];

  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;

    if (line.startsWith('# branch.head ')) {
      const head = stripUnsafeAnsi(line.slice('# branch.head '.length).trim());
      branch = head === '(detached)' ? 'HEAD (detached)' : head;
      continue;
    }
    if (line.startsWith('# branch.upstream ')) {
      upstream = stripUnsafeAnsi(line.slice('# branch.upstream '.length).trim()) || null;
      continue;
    }
    if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) {
        ahead = Number(m[1] ?? 0);
        behind = Number(m[2] ?? 0);
      }
      continue;
    }

    if (line.startsWith('? ')) {
      const filePath = stripUnsafeAnsi(line.slice(2));
      untracked.push({
        path: filePath,
        indexStatus: '?',
        worktreeStatus: '?',
        section: 'untracked',
        label: '?',
      });
      continue;
    }

    if (line.startsWith('u ')) {
      const parts = line.split(' ');
      const filePath = stripUnsafeAnsi(parts.slice(10).join(' '));
      conflicted.push({
        path: filePath,
        indexStatus: 'U',
        worktreeStatus: 'U',
        section: 'conflicted',
        label: '!',
      });
      continue;
    }

    if (line.startsWith('1 ')) {
      const parts = line.split(' ');
      const xy = parts[1] ?? '..';
      const x = xy[0] ?? '.';
      const y = xy[1] ?? '.';
      const filePath = stripUnsafeAnsi(parts.slice(8).join(' '));

      if (x !== '.') {
        staged.push({
          path: filePath,
          indexStatus: x,
          worktreeStatus: y,
          section: 'staged',
          label: statusCodeLabel(x),
        });
      }
      if (y !== '.') {
        unstaged.push({
          path: filePath,
          indexStatus: x,
          worktreeStatus: y,
          section: 'unstaged',
          label: statusCodeLabel(y),
        });
      }
      continue;
    }

    if (line.startsWith('2 ')) {
      const tabIdx = line.indexOf('\t');
      const left = tabIdx >= 0 ? line.slice(0, tabIdx) : line;
      const origPath = tabIdx >= 0 ? stripUnsafeAnsi(line.slice(tabIdx + 1)) : undefined;
      const parts = left.split(' ');
      const xy = parts[1] ?? '..';
      const x = xy[0] ?? '.';
      const y = xy[1] ?? '.';
      const filePath = stripUnsafeAnsi(parts.slice(9).join(' '));

      if (x !== '.') {
        staged.push({
          path: filePath,
          origPath,
          indexStatus: x,
          worktreeStatus: y,
          section: 'staged',
          label: statusCodeLabel(x),
        });
      }
      if (y !== '.') {
        unstaged.push({
          path: filePath,
          origPath,
          indexStatus: x,
          worktreeStatus: y,
          section: 'unstaged',
          label: statusCodeLabel(y),
        });
      }
    }
  }

  return {
    branch,
    upstream,
    ahead,
    behind,
    entries: [...conflicted, ...staged, ...unstaged, ...untracked],
    stagedCount: staged.length,
    unstagedCount: unstaged.length,
    untrackedCount: untracked.length,
    conflictedCount: conflicted.length,
  };
}

/** Parser puro da saída de `git log --graph --format=%x1f%h%x1f%H%x1f%D%x1f%an%x1f%ar%x1f%s`. */
export function parseCommitGraph(
  stdout: string,
  unpushedHashes: ReadonlySet<string> = new Set()
): CommitGraphRow[] {
  const rows: CommitGraphRow[] = [];
  const lines = stdout.split(/\r?\n/);

  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;
    const sepIdx = rawLine.indexOf('\x1f');
    if (sepIdx === -1) {
      rows.push({
        graphPrefix: stripUnsafeAnsi(rawLine),
        isConnectorOnly: true,
        shortHash: '',
        fullHash: '',
        refs: [],
        author: '',
        relativeDate: '',
        subject: '',
        isUnpushed: false,
      });
      continue;
    }

    const graphPrefix = stripUnsafeAnsi(rawLine.slice(0, sepIdx));
    const fields = rawLine.slice(sepIdx + 1).split('\x1f');
    const shortHash = stripUnsafeAnsi(fields[0] ?? '');
    const fullHash = stripUnsafeAnsi(fields[1] ?? '');
    const rawRefs = stripUnsafeAnsi(fields[2] ?? '').trim();
    const author = stripUnsafeAnsi(fields[3] ?? '');
    const relativeDate = stripUnsafeAnsi(fields[4] ?? '');
    const subject = stripUnsafeAnsi(fields[5] ?? '');

    const refs = rawRefs
      ? rawRefs
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean)
      : [];

    rows.push({
      graphPrefix,
      isConnectorOnly: false,
      shortHash,
      fullHash,
      refs,
      author,
      relativeDate,
      subject,
      isUnpushed: unpushedHashes.has(fullHash) || unpushedHashes.has(shortHash),
    });
  }

  return rows;
}

/** Parser puro de `git branch -a --format=...`. */
export function parseBranchesOutput(stdout: string): GitBranchInfo[] {
  const branches: GitBranchInfo[] = [];
  const lines = stdout.split(/\r?\n/);

  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split('\x1f');
    const headMark = (parts[0] ?? '').trim();
    const name = stripUnsafeAnsi((parts[1] ?? '').trim());
    if (!name || name.endsWith('/HEAD')) continue;

    const upstream = stripUnsafeAnsi((parts[2] ?? '').trim());
    const track = stripUnsafeAnsi((parts[3] ?? '').trim());
    const relativeDate = stripUnsafeAnsi((parts[4] ?? '').trim());
    const subject = stripUnsafeAnsi((parts[5] ?? '').trim());
    const isRemote = name.startsWith('origin/') || name.startsWith('upstream/') || name.includes('remotes/');

    branches.push({
      name,
      isCurrent: headMark === '*',
      isRemote,
      upstream,
      track,
      relativeDate,
      subject,
    });
  }

  return branches;
}

/** Resumo ultrarrápido para o badge discreto no cabeçalho do Navegador. */
export async function getGitSummaryBadge(cwd: string): Promise<GitHeaderSummary | null> {
  const rootRes = await runBin('git', ['rev-parse', '--show-toplevel'], cwd, 3000);
  if (!rootRes.ok) return null;
  const repoRoot = rootRes.stdout.trim();
  if (!repoRoot) return null;

  const statusRes = await runBin('git', ['status', '--porcelain=v2', '--branch'], repoRoot, 4000);
  if (!statusRes.ok) return null;

  const parsed = parsePorcelainV2Status(statusRes.stdout);
  const dirtyCount =
    parsed.stagedCount + parsed.unstagedCount + parsed.untrackedCount + parsed.conflictedCount;

  return {
    repoRoot,
    branch: parsed.branch,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    stagedCount: parsed.stagedCount,
    unstagedCount: parsed.unstagedCount,
    untrackedCount: parsed.untrackedCount,
    dirtyCount,
  };
}

/** Carrega snapshot completo local do repositório Git (status, commits parados, árvore e branches). */
export async function loadGitPanelSnapshot(cwd: string): Promise<GitPanelSnapshot> {
  const emptyStatus: ParsedGitStatus = {
    branch: '',
    upstream: null,
    ahead: 0,
    behind: 0,
    entries: [],
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
  };

  const rootRes = await runBin('git', ['rev-parse', '--show-toplevel'], cwd, 4000);
  if (!rootRes.ok || !rootRes.stdout.trim()) {
    return {
      isGitRepo: false,
      repoRoot: cwd,
      repoName: path.basename(cwd),
      remoteUrl: null,
      githubRepo: null,
      status: emptyStatus,
      unpushedCommits: [],
      commitGraph: [],
      branches: [],
      stashCount: 0,
      error: 'O diretório atual não pertence a um repositório Git.',
    };
  }

  const repoRoot = rootRes.stdout.trim();
  const repoName = path.basename(repoRoot);

  const [statusRes, remoteRes, graphRes, branchRes, stashRes] = await Promise.all([
    runBin('git', ['status', '--porcelain=v2', '--branch'], repoRoot),
    runBin('git', ['remote', 'get-url', 'origin'], repoRoot),
    runBin(
      'git',
      [
        'log',
        '--graph',
        '--decorate=short',
        '--all',
        '--color=never',
        '-n',
        '80',
        '--format=%x1f%h%x1f%H%x1f%D%x1f%an%x1f%ar%x1f%s',
      ],
      repoRoot
    ),
    runBin(
      'git',
      [
        'branch',
        '-a',
        '--sort=-committerdate',
        '--format=%(HEAD)%x1f%(refname:short)%x1f%(upstream:short)%x1f%(upstream:track)%x1f%(committerdate:relative)%x1f%(subject)',
      ],
      repoRoot
    ),
    runBin('git', ['stash', 'list'], repoRoot),
  ]);

  const status = statusRes.ok ? parsePorcelainV2Status(statusRes.stdout) : emptyStatus;
  const remoteUrl = remoteRes.ok && remoteRes.stdout.trim() ? sanitizeRemoteUrl(remoteRes.stdout) : null;
  const githubRepo = remoteUrl ? parseGitHubRepoFromUrl(remoteUrl) : null;

  // Commits parados (locais ainda não enviados ao remoto)
  const unpushedArgs = status.upstream
    ? ['log', '@{u}..HEAD', '-n', '30', '--format=%h%x1f%H%x1f%ar%x1f%an%x1f%s']
    : ['log', 'HEAD', '--not', '--remotes', '-n', '30', '--format=%h%x1f%H%x1f%ar%x1f%an%x1f%s'];
  const unpushedRes = await runBin('git', unpushedArgs, repoRoot);

  const unpushedCommits: UnpushedCommit[] = [];
  const unpushedHashes = new Set<string>();
  if (unpushedRes.ok && unpushedRes.stdout.trim()) {
    for (const line of unpushedRes.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [shortHash = '', fullHash = '', relativeDate = '', author = '', subject = ''] = line.split('\x1f');
      if (shortHash) {
        unpushedCommits.push({
          shortHash: stripUnsafeAnsi(shortHash),
          fullHash: stripUnsafeAnsi(fullHash),
          relativeDate: stripUnsafeAnsi(relativeDate),
          author: stripUnsafeAnsi(author),
          subject: stripUnsafeAnsi(subject),
        });
        unpushedHashes.add(shortHash);
        if (fullHash) unpushedHashes.add(fullHash);
      }
    }
  }

  const commitGraph = graphRes.ok ? parseCommitGraph(graphRes.stdout, unpushedHashes) : [];
  const branches = branchRes.ok ? parseBranchesOutput(branchRes.stdout) : [];
  const stashCount = stashRes.ok
    ? stashRes.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean).length
    : 0;

  return {
    isGitRepo: true,
    repoRoot,
    repoName,
    remoteUrl,
    githubRepo,
    status,
    unpushedCommits,
    commitGraph,
    branches,
    stashCount,
  };
}

/** Carrega PRs, Issues e Workflow Runs do GitHub via `gh` CLI com degradação graciosa. */
export async function loadGitHubData(repoRoot: string, githubRepo: string | null): Promise<GitHubPanelData> {
  if (!githubRepo) {
    return {
      available: false,
      loading: false,
      repoSlug: null,
      reason: 'Nenhum remote GitHub (origin) detectado neste repositório.',
      pullRequests: [],
      issues: [],
      workflowRuns: [],
    };
  }

  const authRes = await runBin('gh', ['auth', 'status'], repoRoot, 5000);
  if (!authRes.ok) {
    const missingGh = /ENOENT|not recognized|not found/i.test(authRes.stderr);
    return {
      available: false,
      loading: false,
      repoSlug: githubRepo,
      reason: missingGh
        ? 'GitHub CLI (`gh`) não encontrada no PATH. Instale em https://cli.github.com'
        : 'GitHub CLI (`gh`) não autenticada. Execute `gh auth login` no terminal.',
      pullRequests: [],
      issues: [],
      workflowRuns: [],
    };
  }

  const [prRes, issueRes, runRes] = await Promise.all([
    runBin(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        githubRepo,
        '--state',
        'open',
        '--limit',
        '15',
        '--json',
        'number,title,author,headRefName,baseRefName,isDraft,reviewDecision,updatedAt,url',
      ],
      repoRoot,
      GH_TIMEOUT_MS
    ),
    runBin(
      'gh',
      [
        'issue',
        'list',
        '--repo',
        githubRepo,
        '--state',
        'open',
        '--limit',
        '15',
        '--json',
        'number,title,author,labels,updatedAt,url',
      ],
      repoRoot,
      GH_TIMEOUT_MS
    ),
    runBin(
      'gh',
      [
        'run',
        'list',
        '--repo',
        githubRepo,
        '--limit',
        '8',
        '--json',
        'databaseId,displayTitle,workflowName,headBranch,status,conclusion,updatedAt,url',
      ],
      repoRoot,
      GH_TIMEOUT_MS
    ),
  ]);

  const pullRequests = safeParseJsonArray(prRes.ok ? prRes.stdout : '').map((raw) => ({
    number: Number(raw.number ?? 0),
    title: stripUnsafeAnsi(String(raw.title ?? '')),
    author: stripUnsafeAnsi(String((raw.author as { login?: string } | undefined)?.login ?? 'unknown')),
    headRefName: stripUnsafeAnsi(String(raw.headRefName ?? '')),
    baseRefName: stripUnsafeAnsi(String(raw.baseRefName ?? '')),
    isDraft: Boolean(raw.isDraft),
    reviewDecision: stripUnsafeAnsi(String(raw.reviewDecision ?? '')),
    updatedAt: stripUnsafeAnsi(String(raw.updatedAt ?? '')),
    url: stripUnsafeAnsi(String(raw.url ?? '')),
  }));

  const issues = safeParseJsonArray(issueRes.ok ? issueRes.stdout : '').map((raw) => ({
    number: Number(raw.number ?? 0),
    title: stripUnsafeAnsi(String(raw.title ?? '')),
    author: stripUnsafeAnsi(String((raw.author as { login?: string } | undefined)?.login ?? 'unknown')),
    labels: Array.isArray(raw.labels)
      ? raw.labels
          .map((l) => stripUnsafeAnsi(String((l as { name?: string })?.name ?? '')))
          .filter(Boolean)
      : [],
    updatedAt: stripUnsafeAnsi(String(raw.updatedAt ?? '')),
    url: stripUnsafeAnsi(String(raw.url ?? '')),
  }));

  const workflowRuns = safeParseJsonArray(runRes.ok ? runRes.stdout : '').map((raw) => ({
    id: Number(raw.databaseId ?? 0),
    title: stripUnsafeAnsi(String(raw.displayTitle ?? '')),
    workflowName: stripUnsafeAnsi(String(raw.workflowName ?? '')),
    branch: stripUnsafeAnsi(String(raw.headBranch ?? '')),
    status: stripUnsafeAnsi(String(raw.status ?? '')),
    conclusion: stripUnsafeAnsi(String(raw.conclusion ?? '')),
    updatedAt: stripUnsafeAnsi(String(raw.updatedAt ?? '')),
    url: stripUnsafeAnsi(String(raw.url ?? '')),
  }));

  return {
    available: true,
    loading: false,
    repoSlug: githubRepo,
    pullRequests,
    issues,
    workflowRuns,
  };
}

function safeParseJsonArray(raw: string): Array<Record<string, unknown>> {
  if (!raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

/** Carrega diff sanitizado de um arquivo em Status (staged, unstaged ou untracked). */
export async function loadFileDiff(repoRoot: string, entry: GitStatusEntry): Promise<string[]> {
  if (entry.section === 'untracked') {
    const absPath = path.resolve(repoRoot, entry.path);
    try {
      const stat = await fs.stat(absPath);
      if (stat.isDirectory()) {
        return [`[Diretório não rastreado: ${stripUnsafeAnsi(entry.path)}]`];
      }
      if (stat.size > 256 * 1024) {
        return [`[Arquivo novo grande (${Math.round(stat.size / 1024)} KB) — abra no Leitor para inspecionar]`];
      }
      const buf = await fs.readFile(absPath);
      if (buf.subarray(0, 1024).includes(0)) {
        return [`[Arquivo binário não rastreado: ${stripUnsafeAnsi(entry.path)}]`];
      }
      const lines = buf.toString('utf8').split(/\r?\n/).slice(0, MAX_PREVIEW_DIFF_LINES);
      return [
        `--- /dev/null`,
        `+++ b/${stripUnsafeAnsi(entry.path)}`,
        `@@ -0,0 +1,${lines.length} @@ (arquivo novo)`,
        ...lines.map((l) => `+${stripUnsafeAnsi(l)}`),
      ];
    } catch {
      return [`[Não foi possível ler ${stripUnsafeAnsi(entry.path)}]`];
    }
  }

  const args =
    entry.section === 'staged'
      ? ['diff', '--cached', '--no-color', '--', entry.path]
      : ['diff', '--no-color', '--', entry.path];
  const res = await runBin('git', args, repoRoot);
  if (!res.ok) {
    return [`Erro ao gerar diff: ${stripUnsafeAnsi(res.stderr.trim())}`];
  }
  if (!res.stdout.trim()) {
    return ['(sem alterações textuais visíveis no diff)'];
  }
  return res.stdout
    .split(/\r?\n/)
    .slice(0, MAX_PREVIEW_DIFF_LINES)
    .map((l) => stripUnsafeAnsi(l));
}

/** Carrega detalhes (`git show --stat --patch`) de um commit específico. */
export async function loadCommitDetails(repoRoot: string, hash: string): Promise<string[]> {
  const safeHash = hash.trim();
  if (!/^[0-9a-fA-F]{4,40}$/.test(safeHash)) {
    return ['Hash de commit inválido.'];
  }
  const res = await runBin(
    'git',
    ['show', '--stat', '--patch', '--color=never', safeHash],
    repoRoot
  );
  if (!res.ok) {
    return [`Erro ao inspecionar commit ${safeHash}: ${stripUnsafeAnsi(res.stderr.trim())}`];
  }
  return res.stdout
    .split(/\r?\n/)
    .slice(0, MAX_PREVIEW_DIFF_LINES)
    .map((l) => stripUnsafeAnsi(l));
}

function toCommandResult(res: ExecResult): GitCommandResult {
  const errLine = stripUnsafeAnsi((res.stderr || res.stdout).trim().split(/\r?\n/)[0] ?? '');
  return {
    ok: res.ok,
    stdout: stripUnsafeAnsi(res.stdout),
    stderr: stripUnsafeAnsi(res.stderr),
    errorMessage: res.ok ? undefined : errLine || 'Falha ao executar operação Git.',
  };
}

export async function gitStageFile(repoRoot: string, filePath: string): Promise<GitCommandResult> {
  return toCommandResult(await runBin('git', ['add', '--', filePath], repoRoot));
}

export async function gitUnstageFile(repoRoot: string, filePath: string): Promise<GitCommandResult> {
  const res = await runBin('git', ['restore', '--staged', '--', filePath], repoRoot);
  if (res.ok) return toCommandResult(res);
  // Fallback para repositórios sem commit inicial (unborn HEAD)
  return toCommandResult(await runBin('git', ['rm', '--cached', '--', filePath], repoRoot));
}

export async function gitStageAll(repoRoot: string): Promise<GitCommandResult> {
  return toCommandResult(await runBin('git', ['add', '-A'], repoRoot));
}

export async function gitUnstageAll(repoRoot: string): Promise<GitCommandResult> {
  return toCommandResult(await runBin('git', ['reset', 'HEAD'], repoRoot));
}

export async function gitCommit(repoRoot: string, message: string): Promise<GitCommandResult> {
  const cleanMsg = message.trim();
  if (!cleanMsg) {
    return { ok: false, stdout: '', stderr: '', errorMessage: 'Mensagem de commit vazia.' };
  }
  return toCommandResult(await runBin('git', ['commit', '-m', cleanMsg], repoRoot));
}

export async function gitPull(repoRoot: string): Promise<GitCommandResult> {
  return toCommandResult(await runBin('git', ['pull', '--ff-only'], repoRoot, GIT_NETWORK_TIMEOUT_MS));
}

export async function gitPush(
  repoRoot: string,
  branchWithoutUpstream?: string
): Promise<GitCommandResult> {
  const args = branchWithoutUpstream
    ? ['push', '-u', 'origin', branchWithoutUpstream]
    : ['push'];
  return toCommandResult(await runBin('git', args, repoRoot, GIT_NETWORK_TIMEOUT_MS));
}

export async function gitFetch(repoRoot: string): Promise<GitCommandResult> {
  return toCommandResult(await runBin('git', ['fetch', '--all', '--prune'], repoRoot, GIT_NETWORK_TIMEOUT_MS));
}

export async function gitCheckoutBranch(repoRoot: string, branchName: string): Promise<GitCommandResult> {
  const clean = branchName.trim();
  if (!clean || clean.startsWith('-')) {
    return { ok: false, stdout: '', stderr: '', errorMessage: 'Nome de branch inválido.' };
  }
  const target = clean.startsWith('origin/') ? clean.slice('origin/'.length) : clean;
  return toCommandResult(await runBin('git', ['checkout', target], repoRoot));
}

export async function gitCreateBranch(repoRoot: string, newBranchName: string): Promise<GitCommandResult> {
  const clean = newBranchName.trim();
  if (!clean || clean.startsWith('-') || /\s/.test(clean)) {
    return { ok: false, stdout: '', stderr: '', errorMessage: 'Nome de branch inválido (sem espaços).' };
  }
  return toCommandResult(await runBin('git', ['checkout', '-b', clean], repoRoot));
}

export async function gitStashPush(repoRoot: string): Promise<GitCommandResult> {
  return toCommandResult(await runBin('git', ['stash', 'push', '-u'], repoRoot));
}

export async function gitStashPop(repoRoot: string): Promise<GitCommandResult> {
  return toCommandResult(await runBin('git', ['stash', 'pop'], repoRoot));
}

export async function gitDiscardFile(repoRoot: string, entry: GitStatusEntry): Promise<GitCommandResult> {
  if (entry.section === 'untracked') {
    return toCommandResult(await runBin('git', ['clean', '-f', '--', entry.path], repoRoot));
  }
  return toCommandResult(await runBin('git', ['checkout', '--', entry.path], repoRoot));
}

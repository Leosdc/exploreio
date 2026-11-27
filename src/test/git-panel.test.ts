import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  getGitSummaryBadge,
  gitCommit,
  gitCreateBranch,
  gitStageFile,
  gitUnstageFile,
  loadCommitDetails,
  loadFileDiff,
  loadGitPanelSnapshot,
  parseBranchesOutput,
  parseCommitGraph,
  parseGitHubRepoFromUrl,
  parsePorcelainV2Status,
  sanitizeRemoteUrl,
} from '../git/gitService.js';
import {
  buildGitPanelFrame,
  buildQuickActions,
  buildStatusListItems,
  formatGitHeaderBadge,
  styleDiffLine,
} from '../git/gitView.js';
import { THEME_ORDER, getTheme } from '../themes/palette.js';
import { stripAnsi } from '../tui/ansi.js';

const execFileAsync = promisify(execFile);

test('parseGitHubRepoFromUrl e sanitizeRemoteUrl extraem slug e removem credenciais', () => {
  assert.equal(parseGitHubRepoFromUrl('https://github.com/Leosdc/exploreio.git'), 'Leosdc/exploreio');
  assert.equal(parseGitHubRepoFromUrl('git@github.com:Leosdc/exploreio.git'), 'Leosdc/exploreio');
  assert.equal(parseGitHubRepoFromUrl('ssh://git@github.com/Leosdc/termaid'), 'Leosdc/termaid');
  assert.equal(parseGitHubRepoFromUrl('https://gitlab.com/org/repo.git'), null);

  const sanitized = sanitizeRemoteUrl('https://user:ghp_secret123@github.com/Leosdc/exploreio.git');
  assert.equal(sanitized, 'https://github.com/Leosdc/exploreio.git');
  assert.equal(sanitized.includes('ghp_secret123'), false);
});

test('parsePorcelainV2Status interpreta branch, ahead/behind, staged, unstaged e untracked', () => {
  const sample = [
    '# branch.oid abc123',
    '# branch.head feat/git-panel',
    '# branch.upstream origin/feat/git-panel',
    '# branch.ab +3 -1',
    '1 M. N... 100644 100644 100644 a b src/tui/app.ts',
    '1 .M N... 100644 100644 100644 a b README.md',
    '1 MM N... 100644 100644 100644 a b package.json',
    '? src/git/gitService.ts',
  ].join('\n');

  const parsed = parsePorcelainV2Status(sample);
  assert.equal(parsed.branch, 'feat/git-panel');
  assert.equal(parsed.upstream, 'origin/feat/git-panel');
  assert.equal(parsed.ahead, 3);
  assert.equal(parsed.behind, 1);
  assert.equal(parsed.stagedCount, 2);
  assert.equal(parsed.unstagedCount, 2);
  assert.equal(parsed.untrackedCount, 1);
  assert.equal(parsed.entries.length, 5);
});

test('parseCommitGraph preserva conectores, marca commits parados e sanitiza ANSI', () => {
  const stdout = [
    `* \x1f111aaaa\x1f111aaaa0000\x1fHEAD -> feat/git\x1fLeo\x1f2 min ago\x1ffeat: painel \x1b]0;evil\x07git`,
    `|\\`,
    `| * \x1f222bbbb\x1f222bbbb0000\x1forigin/dev\x1fLeo\x1f1 hour ago\x1fchore: base`,
  ].join('\n');

  const rows = parseCommitGraph(stdout, new Set(['111aaaa0000']));
  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.isUnpushed, true);
  assert.equal(rows[0]?.subject.includes('\x1b'), false);
  assert.deepEqual(rows[0]?.refs, ['HEAD -> feat/git']);
  assert.equal(rows[1]?.isConnectorOnly, true);
  assert.equal(rows[2]?.isUnpushed, false);
});

test('parseBranchesOutput ignora origin/HEAD e identifica branch ativa', () => {
  const stdout = [
    `*\x1ffeat/git-panel\x1forigin/feat/git-panel\x1f[ahead 2]\x1f5 minutes ago\x1ffeat: add git panel`,
    ` \x1fmain\x1forigin/main\x1f\x1f1 day ago\x1frelease v0.5.0`,
    ` \x1forigin/HEAD\x1f\x1f\x1f1 day ago\x1frelease v0.5.0`,
    ` \x1forigin/dev\x1f\x1f\x1f2 days ago\x1fdev sync`,
  ].join('\n');

  const branches = parseBranchesOutput(stdout);
  assert.equal(branches.length, 3);
  assert.equal(branches[0]?.isCurrent, true);
  assert.equal(branches[0]?.track, '[ahead 2]');
  assert.equal(branches[2]?.isRemote, true);
});

test('buildGitPanelFrame e paleta rápida renderizam corretamente nos 3 temas oficiais', () => {
  const snapshot = {
    isGitRepo: true,
    repoRoot: '/tmp/exploreio',
    repoName: 'exploreio',
    remoteUrl: 'https://github.com/Leosdc/exploreio.git',
    githubRepo: 'Leosdc/exploreio',
    status: parsePorcelainV2Status('# branch.head feat/git-panel\n# branch.ab +2 -0\n? novo.ts'),
    unpushedCommits: [
      {
        shortHash: 'abc1234',
        fullHash: 'abc1234567890',
        relativeDate: '3 min ago',
        author: 'Leo',
        subject: 'feat(git): adiciona painel nativo',
      },
    ],
    commitGraph: parseCommitGraph(
      `* \x1fabc1234\x1fabc1234567890\x1fHEAD -> feat/git-panel\x1fLeo\x1f3 min ago\x1ffeat(git): adiciona painel nativo`,
      new Set(['abc1234567890'])
    ),
    branches: parseBranchesOutput(`*\x1ffeat/git-panel\x1f\x1f\x1f3 min ago\x1ffeat(git): adiciona painel nativo`),
    stashCount: 1,
  };

  assert.equal(buildStatusListItems(snapshot).length, 4); // 2 headers + 1 unpushed + 1 untracked
  assert.equal(buildQuickActions(snapshot).length, 9);

  for (const themeName of THEME_ORDER) {
    const theme = getTheme(themeName);
    const badge = stripAnsi(
      formatGitHeaderBadge(
        {
          repoRoot: snapshot.repoRoot,
          branch: 'feat/git-panel',
          upstream: null,
          ahead: 2,
          behind: 0,
          stagedCount: 0,
          unstagedCount: 0,
          untrackedCount: 1,
          dirtyCount: 1,
        },
        theme
      )
    );
    assert.ok(badge.includes('feat/git-panel'));
    assert.ok(badge.includes('↑2'));
    assert.ok(badge.includes('●1'));

    const lines = buildGitPanelFrame(
      {
        snapshot,
        github: {
          available: false,
          loading: false,
          repoSlug: 'Leosdc/exploreio',
          reason: 'offline',
          pullRequests: [],
          issues: [],
          workflowRuns: [],
        },
        activeTab: 'status',
        selectedIndex: 1,
        listScroll: 0,
        detailTitle: 'Diff',
        detailLines: ['+added line', '-removed line', '@@ -1 +1 @@'],
        detailScroll: 0,
        showQuickPalette: true,
        quickPaletteIndex: 0,
        busyMessage: '',
        footerLine: 'footer',
      },
      110,
      28,
      theme
    );
    assert.equal(lines.length, 28);
    const plainFrame = lines.map(stripAnsi).join('\n');
    assert.ok(plainFrame.includes('COMANDOS RÁPIDOS GIT / GITHUB'));
    assert.ok(plainFrame.includes('Leosdc/exploreio'));
    assert.ok(stripAnsi(styleDiffLine('+hello', theme)).includes('+hello'));
  }
});

test('integração Git local: status, stage/unstage, commit parado, árvore, diff e nova branch', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exploreio-git-test-'));
  try {
    await execFileAsync('git', ['init'], { cwd: tmpDir });
    await execFileAsync('git', ['config', 'user.email', 'test@exploreio.local'], { cwd: tmpDir });
    await execFileAsync('git', ['config', 'user.name', 'Exploreio Test'], { cwd: tmpDir });

    const fileA = path.join(tmpDir, 'hello.txt');
    await fs.writeFile(fileA, 'linha 1\n', 'utf8');

    const badge1 = await getGitSummaryBadge(tmpDir);
    assert.ok(badge1);
    assert.equal(badge1.untrackedCount, 1);

    const stageRes = await gitStageFile(tmpDir, 'hello.txt');
    assert.equal(stageRes.ok, true);

    const unstageRes = await gitUnstageFile(tmpDir, 'hello.txt');
    assert.equal(unstageRes.ok, true);

    await gitStageFile(tmpDir, 'hello.txt');
    const commitRes = await gitCommit(tmpDir, 'feat: primeiro commit');
    assert.equal(commitRes.ok, true);

    // Modifica arquivo para validar diff
    await fs.writeFile(fileA, 'linha 1\nlinha 2\n', 'utf8');

    const snap = await loadGitPanelSnapshot(tmpDir);
    assert.equal(snap.isGitRepo, true);
    assert.equal(snap.unpushedCommits.length, 1);
    assert.equal(snap.commitGraph.length >= 1, true);
    assert.equal(snap.status.unstagedCount, 1);

    const diffLines = await loadFileDiff(tmpDir, snap.status.entries[0]!);
    assert.ok(diffLines.some((l) => l.includes('+linha 2')));

    const showLines = await loadCommitDetails(tmpDir, snap.unpushedCommits[0]!.shortHash);
    assert.ok(showLines.some((l) => l.includes('feat: primeiro commit')));

    const branchRes = await gitCreateBranch(tmpDir, 'feat/nova-branch');
    assert.equal(branchRes.ok, true);
    const snap2 = await loadGitPanelSnapshot(tmpDir);
    assert.equal(snap2.status.branch, 'feat/nova-branch');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

import { describe, expect, it } from 'vitest';

import { areasOf, formatOrientation, loadPapercuts, matchPapercuts } from './agent-orient.mjs';

const cuts = [
  {
    id: 'pc_a',
    kind: 'cut',
    ts: '2026-08-11T00:00:00Z',
    severity: 'major',
    tags: ['ios'],
    text: 'axe missing',
  },
  {
    id: 'pc_b',
    kind: 'cut',
    ts: '2026-08-12T00:00:00Z',
    severity: 'minor',
    tags: ['ios-qa'],
    text: 'keyboard hides',
  },
  {
    id: 'pc_c',
    kind: 'cut',
    ts: '2026-08-13T00:00:00Z',
    severity: 'minor',
    tags: ['android'],
    text: 'tap under status bar',
  },
  {
    id: 'pc_d',
    kind: 'cut',
    ts: '2026-08-14T00:00:00Z',
    severity: 'minor',
    tags: ['tooling'],
    text: 'zsh status var',
  },
];

describe('areasOf', () => {
  it('maps paths to areas by longest prefix', () => {
    const areas = areasOf([
      'apps/ios/Sources/A.swift',
      'src/app/x.ts',
      '.gitlab-ci.yml',
      'README.md',
    ]);
    expect([...areas].sort()).toEqual(['.gitlab-ci.yml', 'apps/ios', 'src']);
  });
});

describe('matchPapercuts', () => {
  it('returns the cuts tagged for the touched areas, major first, and nothing for an empty diff', () => {
    const matched = matchPapercuts(cuts, new Set(['apps/ios']));
    expect(matched.map((c) => c.id)).toEqual(['pc_a', 'pc_b']);
    expect(matchPapercuts(cuts, new Set())).toEqual([]);
  });
});

describe('loadPapercuts', () => {
  it('drops cuts that have a resolve entry and ignores malformed lines', () => {
    const file = '/x/.papercuts.jsonl';
    const fake = {
      existsSync: () => true,
      readFileSync: () =>
        [
          JSON.stringify(cuts[0]),
          JSON.stringify(cuts[1]),
          '{not json',
          JSON.stringify({ kind: 'resolve', id: 'pc_a', ts: '2026-08-20T00:00:00Z' }),
        ].join('\n'),
    };
    const { open, total } = loadPapercuts(file, fake);
    expect(total).toBe(2);
    expect(open.map((c) => c.id)).toEqual(['pc_b']);
  });
});

describe('formatOrientation', () => {
  it('prints slot, ports, caches, devices, and matched papercuts on one screen', () => {
    const text = formatOrientation({
      root: '/r/wt',
      primary: '/r',
      linked: true,
      branch: 'chore/x',
      ahead: 2,
      behind: 0,
      dirty: 1,
      slot: 17,
      ports: { tauriVite: 5217, web: 5267, sync: 3117, cdp: 9347, mcp: 9240 },
      nodeModules: false,
      target: { exists: true, profiles: ['debug'] },
      devices: ['android futo-qa-2'],
      server: null,
      purpose: { name: 'agent-dx', created: '2026-09-05T18:00:00Z', session: 'e088bb73-aaaa' },
      papercuts: { open: 135, total: 199, matched: [cuts[0]] },
      sweep: {
        finishedAt: '2026-09-08T07:10:00Z',
        status: 'ok',
        mrUrl: 'https://gitlab.futo.org/x/-/merge_requests/9',
      },
    });
    expect(text).toContain('slot 17');
    expect(text).toContain('VITE_PORT=5217');
    expect(text).toContain('node_modules MISSING → just install');
    expect(text).toContain('android futo-qa-2 (claimed by this worktree)');
    expect(text).toContain('[major] pc_a axe missing');
    expect(text).toContain('purpose:  agent-dx · created 2026-09-05 · session e088bb73');
    expect(text).toContain(
      'papercut sweep: last run 2026-09-08 ok → https://gitlab.futo.org/x/-/merge_requests/9',
    );
    expect(text.split('\n').length).toBeLessThanOrEqual(14);
  });

  it('says so when run outside a checkout', () => {
    expect(formatOrientation({ root: null, error: '/tmp is not inside a git checkout' })).toContain(
      'not inside a git checkout',
    );
  });
});

import { afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { slotOf } from './lib/slot.mjs';

const SCRIPT = fileURLToPath(new URL('./agent-orient.mjs', import.meta.url));
const scratchpads = [];
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

afterEach(() => {
  for (const scratch of scratchpads.splice(0)) fs.rmSync(scratch, { recursive: true });
});

function fixture() {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'futo-orient-')));
  scratchpads.push(scratch);
  const repo = path.join(scratch, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Orientation Test');
  git(repo, 'config', 'user.email', 'orient@example.test');
  git(repo, 'config', 'core.hooksPath', path.join(scratch, 'no-hooks'));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(repo, 'existing.txt'), 'baseline\n');
  fs.writeFileSync(path.join(repo, 'deleted.txt'), 'baseline\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'commit.gpgsign=false', 'commit', '-m', 'baseline');
  const baseline = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'update-ref', 'refs/remotes/origin/main', baseline);
  const worktree = path.join(scratch, 'linked worktree');
  git(repo, 'worktree', 'add', '-b', 'feature', worktree);
  return { repo, worktree, baseline };
}

function orient(cwd, ...args) {
  return spawnSync(process.execPath, [SCRIPT, '--json', ...args], { cwd, encoding: 'utf8' });
}

describe('agent orientation CLI', () => {
  it('includes the whole branch, staged changes, deletions and new files without modifying the checkout', () => {
    const { worktree, baseline } = fixture();
    for (const name of ['first.txt', 'second.txt']) {
      fs.writeFileSync(path.join(worktree, name), name);
      git(worktree, 'add', name);
      git(worktree, '-c', 'commit.gpgsign=false', 'commit', '-m', name);
    }
    fs.writeFileSync(path.join(worktree, 'existing.txt'), 'staged\n');
    git(worktree, 'add', 'existing.txt');
    fs.unlinkSync(path.join(worktree, 'deleted.txt'));
    fs.writeFileSync(path.join(worktree, 'new file\nwith newline.txt'), 'new\n');
    fs.mkdirSync(path.join(worktree, 'node_modules'));
    fs.writeFileSync(path.join(worktree, 'node_modules', 'ignored.txt'), 'ignored');
    const before = git(worktree, 'status', '--porcelain=v1');

    const result = orient(worktree);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.root).toBe(fs.realpathSync(worktree));
    expect(report.branch).toBe('feature');
    expect(report.mergeBase).toBe(baseline);
    expect(report.changes).toEqual({
      committed: ['first.txt', 'second.txt'],
      staged: ['existing.txt'],
      unstaged: ['deleted.txt'],
      untracked: ['new file\nwith newline.txt'],
      all: ['deleted.txt', 'existing.txt', 'first.txt', 'new file\nwith newline.txt', 'second.txt'],
    });
    expect(report.dirty).toBe(3);
    expect(report.dependencies).toBe('present; freshness unchecked');
    expect(git(worktree, 'status', '--porcelain=v1')).toBe(before);
  });

  it('uses the merge base when main advances and supports detached checkouts and explicit bases', () => {
    const { repo, worktree, baseline } = fixture();
    fs.writeFileSync(path.join(repo, 'main-only.txt'), 'main');
    git(repo, 'add', '.');
    git(repo, '-c', 'commit.gpgsign=false', 'commit', '-m', 'main advanced');
    git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'HEAD'));
    git(worktree, 'checkout', '--detach');
    const result = orient(worktree);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.mergeBase).toBe(baseline);
    expect(report.branch).toBe(null);
    expect(report.changes.all).toEqual([]);
    expect(report.dependencies).toBe('missing; run just install');
    expect(JSON.parse(orient(worktree, '--base', baseline).stdout).base).toBe(baseline);
  });

  it('fails with an actionable message when the comparison base is unavailable', () => {
    const { worktree } = fixture();
    const result = orient(worktree, '--base', 'missing-branch');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('git fetch origin main');
    expect(result.stderr).toContain('--base');
    expect(result.stdout).toBe('');
  });

  it('reports another registered worktree sharing its slot without claiming its resources', () => {
    const { repo, worktree } = fixture();
    let peer;
    for (let i = 0; i < 10000; i++) {
      const candidate = path.join(path.dirname(worktree), `peer-${i}`);
      if (slotOf(candidate) === slotOf(worktree)) {
        peer = candidate;
        break;
      }
    }
    expect(peer).toBeDefined();
    git(repo, 'worktree', 'add', '--detach', peer);
    const result = orient(worktree);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).slotPeers).toEqual(
      [repo, peer].filter((candidate) => slotOf(candidate) === slotOf(worktree)),
    );
    expect(git(peer, 'status', '--porcelain=v1')).toBe('');
  });

  it('rejects unknown options rather than silently reporting a different scope', () => {
    const { worktree } = fixture();
    const result = orient(worktree, '--baes', 'HEAD');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Usage:');
  });
});

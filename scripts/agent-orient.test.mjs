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

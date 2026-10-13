import { describe, expect, it } from 'vitest';

import {
  attributeProfile,
  decodeInlineSourceMap,
  ownerOf,
  resolveCallFrame,
  scriptsFromParsedEvents,
  sourceLabel,
} from './profileAttribution.mjs';

/** A map whose generated line L column C is source `files[L]`, line C + 1. */
function fakeScript({ startLine, startColumn, files }) {
  return {
    startLine,
    startColumn,
    lookup: (line, column) =>
      files[line] ? { source: files[line], line: column + 1, column: 0, name: null } : null,
  };
}

describe('resolveCallFrame', () => {
  const scripts = new Map([
    [
      '7',
      fakeScript({ startLine: 10, startColumn: 8, files: ['../../src/a.ts', '../../src/b.ts'] }),
    ],
  ]);

  it('converts document coordinates to the inline script’s own', () => {
    // First script line: the <script> tag's column offset applies.
    expect(resolveCallFrame({ scriptId: '7', lineNumber: 10, columnNumber: 12 }, scripts)).toEqual({
      source: '../../src/a.ts',
      line: 5,
      column: 0,
      name: null,
    });
    // Later lines: no column offset.
    expect(resolveCallFrame({ scriptId: '7', lineNumber: 11, columnNumber: 12 }, scripts)).toEqual({
      source: '../../src/b.ts',
      line: 13,
      column: 0,
      name: null,
    });
  });

  it('returns null for a script without a map or a frame before the script', () => {
    expect(resolveCallFrame({ scriptId: '9', lineNumber: 0, columnNumber: 0 }, scripts)).toBeNull();
    expect(resolveCallFrame({ scriptId: '7', lineNumber: 3, columnNumber: 0 }, scripts)).toBeNull();
  });
});

describe('scriptsFromParsedEvents', () => {
  it('keeps only scripts with an inline map and resolves through it', () => {
    // One mapping: generated (0,0) → sources[0] line 1 col 0. VLQ "AAAA".
    const map = { version: 3, sources: ['../../src/x.ts'], names: [], mappings: 'AAAA' };
    const url = `data:application/json;charset=utf-8;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`;
    const scripts = scriptsFromParsedEvents([
      { scriptId: '1', startLine: 4, startColumn: 0, sourceMapURL: url },
      { scriptId: '2', startLine: 0, startColumn: 0, sourceMapURL: '' },
      { scriptId: '3', startLine: 0, startColumn: 0, sourceMapURL: 'https://example.test/map' },
    ]);
    expect([...scripts.keys()]).toEqual(['1']);
    expect(
      resolveCallFrame({ scriptId: '1', lineNumber: 4, columnNumber: 0 }, scripts),
    ).toMatchObject({
      source: '../../src/x.ts',
      line: 1,
    });
    expect(decodeInlineSourceMap('https://example.test/map')).toBeNull();
    expect(decodeInlineSourceMap(undefined)).toBeNull();
  });
});

describe('labels', () => {
  it('strips the output-relative prefix and pnpm’s store path', () => {
    expect(sourceLabel('../../src/features/editor/milkdown/documentChanges.ts')).toBe(
      'src/features/editor/milkdown/documentChanges.ts',
    );
    expect(
      sourceLabel(
        '../../node_modules/.pnpm/prosemirror-view@1.40.0/node_modules/prosemirror-view/dist/index.js',
      ),
    ).toBe('node_modules/prosemirror-view/dist/index.js');
    expect(sourceLabel(null)).toBe('(unknown)');
  });

  it('owners are the repo area or the package, scoped packages included', () => {
    expect(ownerOf('src/features/editor/milkdown/documentChanges.ts')).toBe('src/features/editor');
    expect(ownerOf('packages/editor/src/markdown/serialize.ts')).toBe('packages/editor/src');
    expect(ownerOf('node_modules/prosemirror-view/dist/index.js')).toBe(
      'node_modules/prosemirror-view',
    );
    expect(ownerOf('node_modules/@milkdown/kit/lib/index.js')).toBe('node_modules/@milkdown/kit');
  });
});

describe('attributeProfile', () => {
  const scripts = new Map([
    [
      '1',
      fakeScript({
        startLine: 0,
        startColumn: 0,
        files: [
          '../../src/features/editor/milkdown/a.ts',
          '../../node_modules/.pnpm/prosemirror-view@1.0.0/node_modules/prosemirror-view/dist/index.js',
        ],
      }),
    ],
  ]);
  const native = (id, functionName) => ({
    id,
    callFrame: { functionName, scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 },
  });
  const profile = {
    nodes: [
      native(1, '(root)'),
      {
        id: 2,
        callFrame: {
          functionName: 'Ft',
          scriptId: '1',
          url: 'file:///editor.html',
          lineNumber: 0,
          columnNumber: 3,
        },
      },
      {
        id: 3,
        callFrame: {
          functionName: 'Gt',
          scriptId: '1',
          url: 'file:///editor.html',
          lineNumber: 1,
          columnNumber: 0,
        },
      },
      native(4, '(garbage collector)'),
      native(5, '(idle)'),
      native(6, '(program)'),
      {
        id: 7,
        callFrame: {
          functionName: 'other',
          scriptId: '9',
          url: 'https://x.test/other.js',
          lineNumber: 4,
          columnNumber: 0,
        },
      },
    ],
    samples: [2, 2, 3, 4, 2, 5, 6, 7],
    timeDeltas: [1000, 1000, 2000, 500, 1000, 9000, 1500, 250],
  };

  it('leaves idle out of the total and reports it separately', () => {
    const summary = attributeProfile(profile, scripts);
    expect(summary.idleMs).toBe(9);
    expect(summary.totalMs).toBe(7.25);
    expect(summary.functions.some((r) => r.label.includes('(idle)'))).toBe(false);
  });

  it('folds self time by resolved function, file and owner', () => {
    const summary = attributeProfile(profile, scripts);
    expect(summary.functions[0]).toEqual({
      label: 'Ft  src/features/editor/milkdown/a.ts:4',
      ms: 3,
      share: 3 / 7.25,
    });
    expect(summary.owners.map((r) => [r.label, r.ms])).toEqual([
      ['src/features/editor', 3],
      ['node_modules/prosemirror-view', 2],
      ['(browser-native)', 2],
      ['(unmapped JS)', 0.25],
    ]);
  });

  it('keeps native work and unmapped JS visible as their own buckets, never dropped', () => {
    const summary = attributeProfile(profile, scripts);
    expect(summary.nativeShare).toBeCloseTo(2 / 7.25);
    expect(summary.unmappedShare).toBeCloseTo(0.25 / 7.25);
    expect(summary.files.map((r) => r.label)).toContain('(browser-native)');
    expect(summary.functions.map((r) => r.label)).toContain('(program)  (browser-native)');
    expect(summary.functions.map((r) => r.label)).toContain('other  other.js:5 (unmapped JS)');
  });

  it('honours top', () => {
    expect(attributeProfile(profile, scripts, { top: 1 }).functions).toHaveLength(1);
  });
});

// Static contracts for justfile recipes whose breakage surfaces as an error
// that names the wrong thing. Each assertion below stands for a papercut an
// agent actually hit and lost time to, so the recipe shape is worth pinning.
//
// These parse the justfile as text rather than running `just`, so the
// assertions need no `just` binary; this file runs inside `pnpm run test:full`.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readJustfileSource } from './lib/justfile.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const justfile = readJustfileSource(ROOT);

// A recipe header is `name [params]: [dependencies]`, so both helpers have to
// tolerate a parameter list — `journal *args:` is as much a recipe named
// `journal` as `build:` is one named `build`.
function header(name) {
  const match = new RegExp(
    `^${name}(?<params> [^\\n:]*)?:(?<rest>[^\\n]*)\\n(?<body>(?:[ \\t][^\\n]*\\n|\\n)*)`,
    'm',
  ).exec(justfile);
  if (!match) throw new Error(`no recipe named '${name}' in the justfile`);
  return match.groups;
}

/** The dependency list on a recipe's header line (`check: a b c` -> `[a, b, c]`). */
function dependencies(name) {
  return header(name).rest.trim().split(/\s+/).filter(Boolean);
}

/** A recipe's indented body lines. */
function body(name) {
  return header(name).body;
}

describe('fresh-worktree install guard', () => {
  // pc_40406aa84bc1: in a new worktree `just check` died inside
  // toolbar-spec-check with 'Command "tsx" not found', which reads as a broken
  // toolchain rather than "this worktree was never installed".
  it('gates the umbrella recipes on node_modules existing', () => {
    expect(dependencies('check')).toContain('check-node-modules');
    expect(dependencies('build')).toContain('_require-node-modules');
  });

  it('names the command that fixes it', () => {
    const guard = body('_require-node-modules');
    expect(guard).toContain('node_modules');
    expect(guard).toContain('just install');
  });

  it('installs workspace dependencies before the cross-platform harness imports them', () => {
    // pc_435a08c1b731: in an uninstalled worktree, Node fell through to an
    // incompatible system `ws` package instead of installing the locked one.
    expect(dependencies('test-cross-platform')).toContain('editor-deps');
  });
});

describe('argument passing', () => {
  // pc_9b7fd5dba746: `just android-drive tap 'Connect & Sync'` exited without
  // tapping anything, because a variadic `*args` is joined into one string
  // before `{{args}}` is interpolated and the shell then re-splits it — the `&`
  // backgrounded a truncated command. Same class: `just journal where --dir
  // '/tmp/a b'` read `/tmp/a`, and `just test-one -t 'two words'` ran the whole
  // suite instead of one test.
  it('passes recipe arguments through as positional arguments', () => {
    expect(justfile).toMatch(/^set positional-arguments(?: := true)?$/m);
  });

  it.each([
    'journal',
    'android-drive',
    'qa-shot',
    'test-unit',
    'test-ios-native',
    'test-ios-native-ui',
    'test-android-native',
    'test-android-perf',
    'test-android-perf-quick',
    'bench-block-drag',
    'bench-editor',
    'bench-climb-gate',
    'qa-server',
    'chunk-census',
    'gauntlet-milkdown-foreign',
    'milkdown-census',
  ])('forwards user-supplied text verbatim in `%s`', (recipe) => {
    const recipeBody = body(recipe);
    expect(recipeBody).toContain('"$@"');
    expect(recipeBody).not.toContain('{{args}}');
  });
});

it('runs native iOS editor stories through the owning UI suites', () => {
  const recipe = body('test-ios-stories');
  expect(recipe).toContain('just test-ios-native-ui');
  expect(recipe).toContain('TextFirstLeaveUITests');
  expect(recipe).toContain('TextFirstSelectionUITests');
  expect(recipe).not.toContain('ios-editor-stories.mjs');
});

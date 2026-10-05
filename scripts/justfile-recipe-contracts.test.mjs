// Static contracts for justfile recipes whose breakage surfaces as an error
// that names the wrong thing. Each assertion below stands for a papercut an
// agent actually hit and lost time to, so the recipe shape is worth pinning.
//
// These parse the justfile as text rather than running `just`: the pinned CI
// image has no `just` at all (see .gitlab-ci.yml), and this file runs inside
// `pnpm run test:full`.

import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const justfile = readFileSync(join(ROOT, 'justfile'), 'utf8');

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
    expect(dependencies('check')).toContain('_require-node-modules');
    expect(dependencies('build')).toContain('_require-node-modules');
  });

  it('names the command that fixes it', () => {
    const guard = body('_require-node-modules');
    expect(guard).toContain('node_modules');
    expect(guard).toContain('just install');
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

  it.each(['journal', 'android-drive', 'qa-shot', 'test-one'])(
    'forwards user-supplied text verbatim in `%s`',
    (recipe) => {
      const recipeBody = body(recipe);
      expect(recipeBody).toContain('"$@"');
      expect(recipeBody).not.toContain('{{args}}');
    },
  );
});

// Exercise the public recipe body with recording commands, never a real device.
it.skipIf(process.platform === 'win32')(
  'accepts an explicit AXe binary before building the iOS stories',
  () => {
    const scratch = mkdtempSync(join(tmpdir(), 'ios-story-preflight-'));
    try {
      const log = join(scratch, 'commands.log');
      for (const command of ['just', 'node']) {
        writeFileSync(
          join(scratch, command),
          '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PREFLIGHT_LOG"\n',
          { mode: 0o755 },
        );
      }
      // `/bin/true` does not exist on macOS (only `/usr/bin/true`); this path
      // must resolve on both macOS and Linux CI.
      const result = spawnSync('/bin/bash', ['-c', body('test-ios-stories')], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: scratch,
          SIM: 'preflight-only',
          AXE_BIN: '/usr/bin/true',
          PREFLIGHT_LOG: log,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
        'ios-native',
        'tests/ios-editor-stories.mjs',
      ]);
    } finally {
      rmSync(scratch, { recursive: true });
    }
  },
);

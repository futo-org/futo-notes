// Static contracts for justfile recipes whose breakage surfaces as an error
// that names the wrong thing. Each assertion below stands for a papercut an
// agent actually hit and lost time to, so the recipe shape is worth pinning.
//
// These parse the justfile as text rather than running `just`: the pinned CI
// image has no `just` at all (see .gitlab-ci.yml), and this file runs inside
// `pnpm run test:full`.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const justfile = readFileSync(join(ROOT, 'justfile'), 'utf8');

/** The dependency list on a recipe's header line (`check: a b c` -> `a b c`). */
function dependencies(name) {
  const header = new RegExp(`^${name}:([^\\n]*)$`, 'm').exec(justfile);
  if (!header) throw new Error(`no recipe named '${name}' in the justfile`);
  return header[1].trim().split(/\s+/).filter(Boolean);
}

/** A recipe's indented body lines. */
function body(name) {
  const match = new RegExp(`^${name}:[^\\n]*\\n((?:[ \\t][^\\n]*\\n|\\n)*)`, 'm').exec(justfile);
  if (!match) throw new Error(`no recipe named '${name}' in the justfile`);
  return match[1];
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

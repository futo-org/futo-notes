// Paths, the bug list, the command line and the shell helpers every step of ../diagnose.mjs uses.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(process.env.DIAGNOSE_SOURCE ?? join(here, '../..'));
const patchFor = (bug) => {
  const ported =
    process.env.DIAGNOSE_PATCHES &&
    join(here, 'bugs', process.env.DIAGNOSE_PATCHES, `${bug.id}.patch`);
  return ported && existsSync(ported) ? ported : join(here, 'bugs', `${bug.id}.patch`);
};
// The operator's own Claude Code session exports its state (CLAUDE_EFFORT, CLAUDE_CODE_CHILD_SESSION,
// …) and a measured or grading session must not inherit it.
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^(CLAUDE|AI_AGENT$|BAGGAGE$)/.test(name)),
);
const bugs = JSON.parse(readFileSync(join(here, 'bugs/bugs.json'), 'utf8'));
// Claude Code loads every AGENTS.md from the working directory up to the root, so a scenario
// nested in a checkout also gets that checkout's (main's, for a worktree) instructions on top
// of its own. DIAGNOSE_DIR puts it outside any checkout.
const outDir = process.env.DIAGNOSE_DIR ?? join(here, 'work/diagnose');
const repoDir = join(outDir, 'repo');
const gitDir = join(outDir, 'gitdir');
const fixture = join(here, 'tool-eval/fixture');
// Kept across bugs: the expensive, answer-free build products.
const KEEP = ['node_modules', 'target', 'dist'];

const [, , command, target, ...flags] = process.argv;
const flag = (name, fallback) => (flags.includes(name) ? flags[flags.indexOf(name) + 1] : fallback);
const model = flag('--model', 'sonnet');
const effort = flag('--effort', null);
const variant = flag('--variant', null); // variants/<name>.patch: a skill/AGENTS.md framing on top of the bug
const say = flag('--say', ''); // appended to the prompt, e.g. a user opting out of Jev
const claudeMd = flag('--claude-md', ''); // a line appended to the repo's CLAUDE.md, the persistent form
const label = flag('--label', variant ?? 'baseline');
const sh = (file, args, options = {}) =>
  execFileSync(file, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
const git = (args, cwd = sourceRoot) => sh('git', args, { cwd });

export {
  bugs,
  claudeMd,
  cleanEnv,
  command,
  effort,
  fixture,
  flag,
  git,
  gitDir,
  here,
  KEEP,
  label,
  model,
  outDir,
  patchFor,
  repoDir,
  say,
  sh,
  sourceRoot,
  target,
  variant,
};

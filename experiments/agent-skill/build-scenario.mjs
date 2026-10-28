#!/usr/bin/env node
/**
 * Re-break a real fix commit into a scenario the agent cannot cheat.
 *
 *   node build-scenario.mjs <scenario-id> [--arm baseline|treatment]
 *
 * The result is a FRESH git repository with exactly one commit — not a worktree.
 * A worktree shares the object store, so `git log main`, `git reflog` and
 * `git show <sha>` would all still reach the real history and hand over the
 * answer. Copying the tree into a new `git init` is the only version that
 * actually withholds it.
 *
 * What is reverted and what is not:
 *   - source hunks        reverted  — this is the bug
 *   - tests the fix added deleted   — otherwise `just check` prints the answer
 *   - docs/learnings/     deleted   — a prose description of the root cause
 *   - docs/spec/          KEPT      — a spec that states correct behaviour over
 *                                    broken code is the realistic case, and it
 *                                    is what a real engineer would read
 *
 * The withheld tests are the answer key: the grader restores and runs them.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { slotOf } from '../../scripts/lib/slot.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const workRoot = join(here, 'work');

/**
 * The two arms are two real commits, not one tree with files swapped.
 *
 * `baseline` is the last commit before the puppet CLI became a skill: the tool
 * is present and documented as a 132-line reference under the verify skill,
 * which is how a normal repo documents a tool it ships. `treatment` is HEAD,
 * where it is its own skill with a trigger, names the drivers it replaces, and
 * `just check-puppet-first` stops the old ones being taught back in.
 *
 * Swapping individual files would have left the routing — AGENTS.md section 9,
 * the verify skill's table — pointing wherever the working tree happened to
 * point, which is the variable under test. Two commits cannot drift.
 */
const ARM_BASE = {
  // The tool present and documented as a reference file under the verify skill —
  // how a normal repo documents a tool it ships.
  baseline: '58550082',
  // The same tool as its own skill, with a trigger, naming the drivers it
  // replaces, plus the gate that stops them being taught back in.
  treatment: 'f672853f',
  // ...and `bugfix` — which owns the "fix a bug" trigger and therefore wins —
  // routing to it, with the failure observed before the test that pins it.
  routed: '0bebcce4',
  // `routed` fixed the diagnosis but not the process: three runs substituted a
  // self-authored Playwright spec for running the product. This arm names that
  // substitution, and the two others that feel like reproduction, as not being
  // one.
  observed: '4322a97e',
  // Everything the pilot taught, together: the skill and its gate, observe
  // before you test, the substitution named, and the spec as the contract.
  current: 'c16c3b68',
  // `current` plus real mouse input on desktop: `just puppet click`/`drag` land in
  // the app's own web view instead of the desktop having typed verbs only.
  'desktop-input': '8aeaadf0',
  // One skill drives the apps: bugfix removed, commands first, click hold, cursor in at/show.
  'single-skill': '6429757e',
  // This branch: editing is Type/Press, `drive` exists, and the prompt asks for in-app
  // verification in the words a developer would use.
  drive: '3ccebb12',
  // main where this branch forked from it (2026-09-11): the same product code with none
  // of the agent tooling — no `futo-puppet`, no agent skill; AGENTS.md says `/verify` and
  // the desktop MCP bridge. Current main has moved on under three of the scenarios.
  old: '35ff2ec0',
  // drive-first: the skill routes every one-sentence reproduction to `drive`, and a
  // session-start probe says whether Jev can run (claude/jev-drive-first).
  drivefirst: 'ad7e14fa',
};

/**
 * A scenario repo's ports and QA devices come from a hash of its own path, so
 * two of them — or one of them and the checkout you are working in — can land
 * on the same slot and fight over the same simulator and the same dev server.
 * Nudge the directory name until the slot is free. Suffixing the PATH is the
 * whole mechanism, because the path is the only input.
 */
function unusedSlotDir(preferred) {
  const taken = new Set([slotOf(repoRoot)]);
  for (const entry of existsSync(workRoot) ? readdirSync(workRoot) : []) {
    if (entry.startsWith('.') || entry === preferred) continue;
    taken.add(slotOf(join(workRoot, entry, 'repo')));
  }
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const name = attempt === 0 ? preferred : `${preferred}-${attempt + 1}`;
    if (!taken.has(slotOf(join(workRoot, name, 'repo')))) return join(workRoot, name);
  }
  throw new Error(`no free slot for ${preferred} — release some scenarios first`);
}

const git = (args, cwd = repoRoot) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** A path whose contents would name the bug outright. */
const isTestPath = (path) =>
  /(^|\/)tests?\//.test(path) ||
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) ||
  /Tests?\.(swift|kt)$/.test(path) ||
  /(^|\/)src\/test\//.test(path);

const isLearningPath = (path) => path.startsWith('docs/learnings/');
const isSpecPath = (path) => path.startsWith('docs/spec/');

/**
 * One commit, no parents, no remotes — checked out as a LINKED worktree of its own bare
 * repo. Both halves matter. `just tauri-dev` isolates the vault only when `.git` is a file
 * (a plain repo ran the scenario app against the developer's ~/Documents/fake-notes), and
 * `qa-target` finds the app only when `git worktree list` names this checkout (a
 * `--separate-git-dir` repo names the gitdir instead, and every `just puppet` call answered
 * "no debug desktop app of this worktree").
 */
function commitAsLinkedWorktree(outDir, repoDir) {
  const gitDir = join(outDir, 'gitdir');
  const content = `${repoDir}.content`;
  rmSync(content, { recursive: true, force: true });
  execFileSync('mv', [repoDir, content]);
  git(['init', '--quiet', '--bare', '--initial-branch=main', gitDir]);
  const inContent = ['--git-dir', gitDir, '--work-tree', content];
  git([...inContent, 'add', '-A']);
  git([
    ...inContent,
    '-c',
    'user.name=FUTO Notes',
    '-c',
    'user.email=dev@futo.org',
    'commit',
    '--quiet',
    '-m',
    'FUTO Notes',
  ]);
  git(['--git-dir', gitDir, 'worktree', 'add', '--quiet', repoDir, 'main']);
  rmSync(content, { recursive: true, force: true });
}

function buildScenario(scenario, arm) {
  const sha = scenario.sha ? git(['rev-parse', scenario.sha]).trim() : null;
  const outDir = unusedSlotDir(`${scenario.id}--${arm}`);
  const repoDir = join(outDir, 'repo');
  const answerDir = join(outDir, 'answer');
  const stagingDir = join(workRoot, `.staging-${scenario.id}-${arm}`);

  rmSync(outDir, { recursive: true, force: true });
  rmSync(stagingDir, { recursive: true, force: true });
  // A stale worktree registration outlives the directory it pointed at.
  git(['worktree', 'prune']);
  mkdirSync(answerDir, { recursive: true });

  // 1. The arm's codebase with one old fix undone — NOT a checkout at the fix.
  //    A scenario built at the fix commit is a repo that predates the tooling
  //    the experiment is measuring, so the agent could not use it even if it
  //    wanted to. A fix that no longer reverts cleanly has been overtaken by
  //    later work and is not a usable scenario; say so and skip.
  git(['worktree', 'add', '--detach', stagingDir, ARM_BASE[arm]]);
  if (scenario.kind === 'feature') {
    try {
      writeFileSync(
        join(answerDir, 'answer.json'),
        `${JSON.stringify({ id: scenario.id, arm, kind: 'feature', platform: scenario.platform, check: scenario.check, sourceFilesReverted: [], withheldTests: [], specKept: [] }, null, 2)}\n`,
      );
      writeFileSync(join(answerDir, 'fix.diff'), '(a feature: there is no reference fix)\n');
      mkdirSync(repoDir, { recursive: true });
      execFileSync(
        'rsync',
        ['-a', '--exclude', '.git', '--exclude', 'experiments/', `${stagingDir}/`, `${repoDir}/`],
        { stdio: 'inherit' },
      );
    } finally {
      git(['worktree', 'remove', '--force', stagingDir]);
    }
    commitAsLinkedWorktree(outDir, repoDir);
    writeFileSync(join(outDir, 'REQUEST.md'), `${scenario.request}\n`);
    return { outDir, repoDir, answerDir, sha: ARM_BASE[arm] };
  }
  try {
    const touched = git(['show', '--name-status', '--format=', sha])
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [status, ...rest] = line.split('\t');
        return { status: status[0], path: rest[rest.length - 1] };
      });

    // 2. Undo the whole commit, then put back the parts that are not the answer.
    try {
      git(['revert', '--no-commit', sha], stagingDir);
    } catch (error) {
      const conflicts = git(['diff', '--name-only', '--diff-filter=U'], stagingDir).trim();
      throw new Error(
        `${scenario.id} (${sha.slice(0, 8)}) no longer reverts onto HEAD — later work ` +
          `overtook it. Conflicts:\n  ${conflicts.split('\n').join('\n  ')}`,
        { cause: error },
      );
    }

    const specPaths = touched.filter((f) => isSpecPath(f.path)).map((f) => f.path);
    if (specPaths.length) git(['checkout', sha, '--', ...specPaths], stagingDir);

    // 3. The withheld answer key: every test file the fix TOUCHED, kept out of
    //    the tree. Added ones the revert deleted outright; modified ones it
    //    rolled back to the version that predates the new case. Either way the
    //    fix's version is the oracle, and the tree no longer names the bug.
    const withheldTests = touched.filter((f) => f.status !== 'D' && isTestPath(f.path));
    for (const file of withheldTests) {
      writeFileSync(
        join(answerDir, file.path.replaceAll('/', '__')),
        git(['show', `${sha}:${file.path}`]),
      );
    }
    for (const file of touched.filter((f) => isLearningPath(f.path) && f.status === 'A')) {
      rmSync(join(stagingDir, file.path), { force: true });
    }

    writeFileSync(join(answerDir, 'fix.diff'), git(['show', sha]));
    writeFileSync(
      join(answerDir, 'answer.json'),
      `${JSON.stringify(
        {
          id: scenario.id,
          arm,
          sha,
          subject: git(['show', '--format=%s', '--no-patch', sha]).trim(),
          platform: scenario.platform,
          sourceFilesReverted: touched
            .filter((f) => !isTestPath(f.path) && !isSpecPath(f.path) && !isLearningPath(f.path))
            .map((f) => f.path),
          withheldTests: withheldTests.map((f) => f.path),
          specKept: specPaths,
        },
        null,
        2,
      )}\n`,
    );

    // 4. Copy the tree WITHOUT .git, so the new repo starts with no history.
    mkdirSync(repoDir, { recursive: true });
    execFileSync(
      'rsync',
      ['-a', '--exclude', '.git', '--exclude', 'experiments/', `${stagingDir}/`, `${repoDir}/`],
      { stdio: 'inherit' },
    );
  } finally {
    git(['worktree', 'remove', '--force', stagingDir]);
  }

  // 5. One commit, no parents, no remotes, no reflog worth reading.
  commitAsLinkedWorktree(outDir, repoDir);

  writeFileSync(join(outDir, 'BUG_REPORT.md'), `${scenario.symptom}\n`);
  return { outDir, repoDir, answerDir, sha };
}

const argv = process.argv.slice(2);
// The scenario id is the first bare word; everything else is flags, so
// `--arm treatment` alone means "every scenario, treatment arm".
const flagIndex = argv.findIndex((a) => a.startsWith('--'));
const scenarioId = flagIndex === 0 ? undefined : argv[0];
const flags = argv.slice(scenarioId ? 1 : 0);
const arm = flags.includes('--arm') ? flags[flags.indexOf('--arm') + 1] : 'baseline';
if (!Object.hasOwn(ARM_BASE, arm)) throw new Error(`unknown arm: ${arm}`);

const scenarios = JSON.parse(readFileSync(join(here, 'scenarios.json'), 'utf8'));
const wanted = scenarioId ? scenarios.filter((s) => s.id === scenarioId) : scenarios;
if (!wanted.length) throw new Error(`no scenario '${scenarioId}'`);

mkdirSync(workRoot, { recursive: true });
for (const scenario of wanted) {
  const built = buildScenario(scenario, arm);
  const answer = JSON.parse(readFileSync(join(built.answerDir, 'answer.json'), 'utf8'));
  console.log(
    `${scenario.id} [${arm}] → ${built.repoDir}\n` +
      `  reverted ${answer.sourceFilesReverted.length} source file(s), ` +
      `withheld ${answer.withheldTests.length} test file(s), ` +
      `kept ${answer.specKept.length} spec file(s)`,
  );
}

if (!existsSync(join(workRoot, '.gitignore'))) {
  writeFileSync(join(workRoot, '.gitignore'), '*\n');
}

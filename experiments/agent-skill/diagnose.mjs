#!/usr/bin/env node
/**
 * Diagnosis tests: one old bug put back into today's code, a short human bug report, and a
 * fresh agent asked to figure out what's going on. Scored on whether it RECREATED the bug in
 * the app (from its tool calls, not its prose) and whether it found WHY.
 *
 *   node diagnose.mjs run <bug-id|all> [--model sonnet]    build, launch, run the agent, grade
 *   node diagnose.mjs grade <bug-id> [--run <runId>]        re-grade a finished run
 *   node diagnose.mjs report                                table of the latest run per bug
 *
 * One scenario directory is reused for every bug (disk: one cargo target, not one per bug).
 * For each bug it becomes a FRESH one-commit repo — the checkout as it is on disk plus bugs/<id>.patch — so git
 * history cannot hand over the answer; the patch also withholds the fix's regression tests.
 * DIAGNOSE_SOURCE=<checkout> builds from another checkout (e.g. main, without `just puppet`);
 * DIAGNOSE_PATCHES=<dir> prefers bugs/<dir>/<id>.patch, a port of the same bug to that checkout.
 * ponytail: desktop only; the phones need a build per bug and come after desktop looks sane.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { stopIfLoggedOut } from './lib.mjs';
import {
  bugs,
  claudeMd,
  cleanEnv,
  command,
  effort,
  flag,
  git,
  here,
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
} from './diagnose/config.mjs';
import { grade, keepReadImages } from './diagnose/grade.mjs';
import { build, seedVault } from './diagnose/scenario-repo.mjs';

// The person asks for the reproduction, as a session of theirs would: reproducing a reported bug
// is the user's instruction (or a bug-hunting skill's), not the project's (Mason, 2026-10-06).
const PROMPT = (bug) =>
  `${bug.prompt}\n\nReproduce it in the running app first, then figure out what's going on.${say ? ` ${say}` : ''}`;

/** `pkill`/`killall` refused and logged: they reach every checkout on this machine (AGENTS.md M25). */
function shim(runDir) {
  const dir = join(outDir, 'shim');
  mkdirSync(dir, { recursive: true });
  for (const name of ['pkill', 'killall']) {
    writeFileSync(
      join(dir, name),
      `#!/bin/sh\necho "$(date -u +%FT%TZ) ${name} $*" >> "${join(runDir, 'blocked-kills.log')}"\necho "${name}: refused — terminate by identity (AGENTS.md M25)" >&2\nexit 1\n`,
    );
    sh('chmod', ['+x', join(dir, name)]);
  }
  return dir;
}

function launch(runDir) {
  const log = openSync(join(runDir, 'app.log'), 'a');
  const child = spawn('just', ['tauri-dev'], {
    cwd: repoDir,
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  // With `just puppet`, its first call also builds the CLI, so the agent's first call is not a compile.
  const hasPuppet = /^puppet\b/m.test(readFileSync(join(repoDir, 'justfile'), 'utf8'));
  const deadline = Date.now() + 900_000;
  while (Date.now() < deadline) {
    if (
      hasPuppet
        ? spawnSync('just', ['puppet', 'state'], { cwd: repoDir, timeout: 600_000 }).status === 0
        : bridgeAnswers(runDir, '!!window.__notesShellTest') === true
    )
      return child.pid;
    spawnSync('sleep', ['5']);
  }
  throw new Error(`the app did not come up — see ${runDir}/app.log`);
}

/** `script` evaluated in the app's webview over the debug bridge this run's app.log announced; undefined if it does not answer. */
function bridgeAnswers(runDir, script) {
  const port = /initialized for .* on [^:\s]+:(\d+)/.exec(
    readFileSync(join(runDir, 'app.log'), 'utf8'),
  )?.[1];
  if (!port) return undefined;
  const probe = `const ws = new WebSocket('ws://127.0.0.1:${port}');
ws.onopen = () => ws.send(JSON.stringify({ id: 'r1', command: 'execute_js', args: { script: ${JSON.stringify(script)} } }));
ws.onmessage = (m) => { console.log(m.data); process.exit(0); };
ws.onerror = () => process.exit(1);`;
  const { stdout } = spawnSync('node', ['-e', probe], { encoding: 'utf8', timeout: 15_000 });
  try {
    const reply = JSON.parse(stdout);
    return reply.success ? reply.data : undefined;
  } catch {
    return undefined;
  }
}

function stop(pid) {
  try {
    process.kill(-pid, 'SIGTERM'); // the group, by id — never by name (M25)
  } catch {
    /* gone */
  }
  spawnSync('sleep', ['3']);
  // An instance the agent launched itself is outside that group; this stops only the scenario's own.
  spawnSync('node', ['scripts/qa-target.mjs', 'kill'], { cwd: repoDir, stdio: 'ignore' });
}

function runAgent(bug, runDir) {
  const prompt = PROMPT(bug);
  writeFileSync(join(runDir, 'prompt.txt'), `${prompt}\n`);
  const startedAt = Date.now();
  const child = spawnSync(
    'claude',
    [
      '-p',
      prompt,
      '--model',
      model,
      ...(effort ? ['--effort', effort] : []),
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--setting-sources',
      'project',
      '--strict-mcp-config', // no MCP servers, not even the account's claude.ai connectors
      // Which AGENTS.md/CLAUDE.md files the session loaded: grep debug.log for "AGENTS.md loaded".
      '--debug-file',
      join(runDir, 'debug.log'),
      // A -p run ends at the final reply; background subagents outlived two runs and left no answer.
      '--disallowedTools',
      'Agent',
      '--append-system-prompt',
      'This is a non-interactive run: nobody is available to approve a plan or answer questions, so do not stop to ask. Carry the request through yourself. Background tasks and background subagents do not survive this run: it ends at your final reply, so run everything in the foreground and finish with your answer.',
    ],
    {
      cwd: repoDir,
      env: {
        ...cleanEnv,
        PATH: `${shim(runDir)}:${process.env.PATH}`,
      },
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      timeout: 45 * 60_000,
    },
  );
  writeFileSync(join(runDir, 'transcript.jsonl'), child.stdout ?? '');
  writeFileSync(join(runDir, 'agent.stderr'), child.stderr ?? '');
  stopIfLoggedOut(child.stdout ?? '');
  writeFileSync(join(runDir, 'agent.diff'), git(['diff', 'HEAD'], repoDir));
  keepReadImages(runDir);
  return Math.round((Date.now() - startedAt) / 1000);
}

function runOne(bug) {
  const runDir = join(
    here,
    'runs-diagnose',
    bug.id,
    `${label}--${new Date().toISOString().replace(/[:.]/g, '-')}`,
  );
  mkdirSync(runDir, { recursive: true });
  console.log(`== ${bug.id}: build`);
  build(bug);
  seedVault();
  console.log(`== ${bug.id}: launch`);
  const pid = launch(runDir);
  try {
    console.log(`== ${bug.id}: agent (${model})`);
    // DIAGNOSE_MAX_LOAD holds the agent until the machine is that quiet (1-minute load average), so a
    // neighbouring lane's compile does not slow the session being timed.
    while (loadavg()[0] > (Number(process.env.DIAGNOSE_MAX_LOAD) || Infinity))
      spawnSync('sleep', ['15']);
    const loadAtStart = loadavg()[0];
    const seconds = runAgent(bug, runDir);
    writeFileSync(
      join(runDir, 'run.json'),
      `${JSON.stringify({ bug: bug.id, model, effort, seconds, loadAtStart, label, source: sourceRoot, patch: patchFor(bug), variant, say, claudeMd }, null, 2)}\n`,
    );
  } finally {
    stop(pid);
    // The run's traces (.puppet/trace.jsonl, .puppet/drive/*.json) belong with the run, not the next build.
    const traces = join(repoDir, '.puppet');
    if (existsSync(traces)) renameSync(traces, join(runDir, 'agent'));
  }
  const score = grade(bug, runDir);
  console.log(
    `== ${bug.id} [${label}]: recreated ${score.recreated} · cause ${score.cause} · ${score.appCalls} app calls (${score.driveCalls} drive${score.driveFirst ? ', first' : ''}${score.driveOutcomes.length ? `: ${score.driveOutcomes.join(',')}` : ''}) · $${score.costUsd?.toFixed(2)}`,
  );
}

function report() {
  const rows = [];
  for (const bug of bugs) {
    const dir = join(here, 'runs-diagnose', bug.id);
    if (!existsSync(dir)) continue;
    for (const runId of readdirSync(dir).sort()) {
      if (!existsSync(join(dir, runId, 'score.json'))) continue;
      const score = JSON.parse(readFileSync(join(dir, runId, 'score.json'), 'utf8'));
      const run = JSON.parse(readFileSync(join(dir, runId, 'run.json'), 'utf8'));
      if (target && run.label !== target && !(target === 'baseline' && !run.label)) continue;
      const driveCell = `${score.driveCalls}${score.driveFirst ? ' first' : ''}${score.driveOutcomes?.length ? ` (${score.driveOutcomes.join(', ')})` : ''}${score.gateRefusals ? ` · ${score.gateRefusals} gated` : ''}${score.jevOffCalls ? ` · ${score.jevOffCalls} JEV=off` : ''}`;
      rows.push(
        `| ${bug.id} | ${run.label ?? 'baseline'} | ${run.say || run.claudeMd || (run.jev === 'off' ? 'FUTO_PUPPET_JEV=off' : '')} | ${score.recreated ? '✓' : '✗'} | ${score.cause} | ${score.appCalls} | ${driveCell} | ${run.seconds}s | $${score.costUsd?.toFixed(2)} |`,
      );
    }
  }
  console.log(
    [
      '| bug | arm | opt-out | recreated | cause | app calls | drive | time | cost |',
      '|---|---|---|---|---|---|---|---|---|',
      ...rows,
    ].join('\n'),
  );
}

if (command === 'report') report();
else {
  const wanted =
    target === 'all'
      ? bugs.filter((b) => b.platforms.includes('desktop'))
      : bugs.filter((b) => b.id === target);
  if (!wanted.length) throw new Error(`no bug '${target}'`);
  for (const bug of wanted) {
    if (command === 'run') runOne(bug);
    else if (command === 'grade') {
      const dir = join(here, 'runs-diagnose', bug.id);
      console.log(grade(bug, join(dir, flag('--run', readdirSync(dir).sort().pop()))));
    } else throw new Error(`unknown command ${command}`);
  }
}

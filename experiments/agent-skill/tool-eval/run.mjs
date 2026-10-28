// Benchmarks the app the way it is really driven: a Claude Code session in this worktree gets a
// person's request, with the repo's own instructions and the agent skill, and drives the app with
// `just puppet` as a session of yours would.
// One task at a time against this worktree's dev app, reset to the task's vault between tasks.
//
//   node run.mjs --label <name> [--set workflows|tasks|heldout|editor] [--model opus|sonnet] [--effort low|medium|high|xhigh|max]
//                [--only id,id] [--resume] [--holdout include|exclude|only]
//
// A `tasks.json` task is scored on its answer; a `workflows.mjs` or held-out task on its verifier
// over the vault and `state` (plus the answer when it names an `expected`). A session answers in
// prose, so its answer passes when it contains the expected value. `summary.json` beside the
// report is what loop.mjs reads.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mainTree, oracle, reset, target } from './reset.mjs';
import { workflows } from './workflows.mjs';
import { stopIfLoggedOut } from '../lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const label = arg('label', new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'));
const model = arg('model', 'opus');
const effort = arg('effort', null);
const set = arg('set', 'workflows');
const holdout = arg('holdout', 'include');
const only = arg('only', '')?.split(',').filter(Boolean);
// Times are only comparable on a quiet machine: refuse to start on a busy one (`--busy` overrides),
// and record the load on every task so a run that got busy shows it.
const load = () => Number(loadavg()[0].toFixed(1));
if (load() > cpus().length && !process.argv.includes('--busy'))
  throw new Error(`load ${load()} is above ${cpus().length} cores: wait, or pass --busy`);
const runDir = join(here, 'runs', label);
mkdirSync(runDir, { recursive: true });

const normalize = (text) =>
  (text ?? '')
    .trim()
    .replace(/^[`"']+|[`"']+$/g, '')
    .replace(/,\s+/g, ',')
    .trim();

// What headless changes and nothing else: nobody can approve a plan (a personal "okay my plan
// first" rule ends a -p run at turn one), and background work dies with the run.
const NON_INTERACTIVE =
  'This is a non-interactive run: nobody is available to approve a plan or answer questions, so do not stop to ask. Carry the request through yourself. Background tasks and background subagents do not survive this run: it ends at your final reply, so run everything in the foreground and finish with your answer.';
// A session that reaches for anything else would stop and ask you; here it is denied and counted.
// A phone's commands carry its target, as the skill teaches, so the rule names it too.
// The main arm (FUTO_HARNESS_MAIN_TREE, reset.mjs) runs in a checkout of main, which drives the
// app the way main's /verify teaches: shell scripts over the debug bridge. Edits stay denied in
// both arms, and so do the habits AGENTS.md forbids (M24, M25).
const SESSION_TOOLS = [
  mainTree ? 'Bash' : 'Bash(just puppet:*)',
  'Read',
  'Grep',
  'Glob',
  'Skill',
  ...(target === 'desktop'
    ? []
    : [
        `Bash(FUTO_PUPPET_TARGET=${target} just puppet:*)`,
        `Bash(export FUTO_PUPPET_TARGET=${target})`,
      ]),
];
const WHERE = {
  desktop: 'In the FUTO Notes desktop debug app that is running',
  ios: 'In the FUTO Notes debug app running on the iOS simulator',
  android: 'In the FUTO Notes debug app running on the Android emulator',
};

function driveAsSession(task) {
  // A fresh session names itself rather than inheriting this process's.
  const { CLAUDECODE: _code, CLAUDE_CODE_SESSION_ID: _session, ...inherited } = process.env;
  const child = spawnSync(
    'claude',
    [
      '-p',
      `${WHERE[target]}: ${task.prompt}`,
      '--model',
      model,
      ...(effort ? ['--effort', effort] : []),
      '--output-format',
      'stream-json',
      '--verbose',
      '--setting-sources',
      'project',
      '--permission-mode',
      'default',
      '--allowedTools',
      ...SESSION_TOOLS,
      // The tasks, their vault and the write-up of past runs are in this checkout; reading them is not driving.
      '--disallowedTools',
      'Agent',
      'Read(./experiments/**)',
      'Read(./docs/learnings/puppet-agent-driving.md)',
      'Read(./docs/learnings/puppet-agent-driving/**)',
      ...(mainTree
        ? [
            `Read(/${here}/**)`,
            'Bash(pkill:*)',
            'Bash(killall:*)',
            'Bash(osascript:*)',
            'Bash(cliclick:*)',
          ]
        : []),
      '--append-system-prompt',
      NON_INTERACTIVE,
    ],
    {
      cwd: mainTree ?? repo,
      env: inherited,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      timeout: 30 * 60_000,
    },
  );
  const events = (child.stdout ?? '')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  writeFileSync(join(runDir, `${task.id}.jsonl`), child.stdout ?? '');
  stopIfLoggedOut(child.stdout ?? '');
  const calls = events
    .filter((event) => event.type === 'assistant')
    .flatMap((event) => event.message.content.filter((block) => block.type === 'tool_use'))
    .map((block) => block.input.command ?? `${block.name} ${JSON.stringify(block.input)}`);
  const toolResults = events
    .filter((event) => event.type === 'user')
    .flatMap((event) => (Array.isArray(event.message.content) ? event.message.content : []))
    .filter((block) => block.type === 'tool_result');
  const final = events.find((event) => event.type === 'result');
  return {
    actual: final?.result ?? null,
    calls,
    toolErrors: toolResults.filter((block) => block.is_error).length,
    denied:
      final?.permission_denials?.length ??
      toolResults.filter((block) => JSON.stringify(block.content).includes('permission')).length,
    costUsd: final?.total_cost_usd ?? 0,
    turns: final?.num_turns ?? null,
    stderr: child.stderr?.trim() || (child.error ? String(child.error) : null),
  };
}

// `heldout` and `editor` bring their own ~500-note vault (heldout/README.md); the others share fixture/.
const setModule = { heldout: './heldout/tasks.mjs', editor: './heldout/editor-tasks.mjs' }[set];
const heldout = setModule ? await import(setModule) : null;
const pool =
  set === 'tasks'
    ? JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8'))
    : heldout
      ? heldout.tasks
      : workflows;
const chosen = pool
  .filter((task) => holdout === 'include' || (holdout === 'only') === Boolean(task.holdout))
  .filter((task) => !only.length || only.includes(task.id));
// A task about a surface this target does not have is not a failure and not a pass: it is not a
// task here. Skipped by name in the report so the denominator stays honest.
const skipped = target === 'desktop' ? [] : chosen.filter((task) => task.desktopOnly);
const tasks = chosen.filter((task) => !skipped.includes(task));
if (skipped.length) console.log(`not on ${target}: ${skipped.map((task) => task.id).join(', ')}`);

// `--resume` keeps finished tasks' .json and runs the rest; the report covers all of them.
const results = [];
for (const task of tasks) {
  const done = join(runDir, `${task.id}.json`);
  if (process.argv.includes('--resume') && existsSync(done)) {
    results.push(JSON.parse(readFileSync(done, 'utf8')));
    continue;
  }
  process.stdout.write(`${task.id} … `);
  const blank = {
    id: task.id,
    holdout: Boolean(task.holdout),
    prompt: task.prompt,
    expected: task.expected ?? null,
    actual: null,
    verdict: null,
    score: 0,
    lenient: 0,
    seconds: 0,
    costUsd: 0,
    turns: 0,
    calls: [],
    toolErrors: 0,
    denied: 0,
    stderr: null,
  };
  try {
    await reset(heldout?.fixture);
  } catch (error) {
    console.log(`harness: ${error.message.slice(0, 120)}`);
    results.push({ ...blank, stderr: `reset failed: ${error.message}` });
    continue;
  }
  const startedAt = Date.now();
  const { actual, calls, toolErrors, denied, costUsd, turns, stderr } = driveAsSession(task);
  // A verifier's complaint is the verdict; an answer task's verdict is the mismatch.
  const answered = normalize(actual).includes(normalize(task.expected));
  const responseOk = task.expected == null || answered;
  let verdict = null;
  if (task.verify) {
    try {
      verdict = task.verify(oracle());
    } catch (error) {
      verdict = `verifier threw: ${error.message}`;
    }
  }
  if (!verdict && !responseOk)
    verdict = `answer ${JSON.stringify(actual?.slice(0, 200))} lacks ${JSON.stringify(task.expected)}`;
  const result = {
    ...blank,
    actual,
    verdict,
    score: Number(verdict === null),
    // Right answer, wrong wrapping (prose around it): a formatting miss, not a tool miss.
    lenient: Number(
      (verdict === null || verdict.startsWith('answer ')) &&
        (task.expected == null || normalize(actual).includes(normalize(task.expected))),
    ),
    seconds: Math.round((Date.now() - startedAt) / 10) / 100,
    load: load(),
    costUsd,
    turns,
    calls,
    toolErrors,
    denied,
    stderr,
  };
  results.push(result);
  writeFileSync(join(runDir, `${task.id}.json`), JSON.stringify(result, null, 2));
  console.log(
    `${result.score ? '✓' : '✗'} ${result.seconds}s ${calls.length} calls $${result.costUsd?.toFixed(3) ?? '?'}${result.score ? '' : `  ${verdict}`}`,
  );
}

const sum = (key) =>
  results.reduce(
    (total, r) => total + (typeof r[key] === 'number' ? r[key] : (r[key]?.length ?? 0)),
    0,
  );
const summary = {
  label,
  model,
  effort,
  set,
  holdout,
  target,
  tasks: results.length,
  skipped: skipped.map((task) => task.id),
  passed: sum('score'),
  lenient: sum('lenient'),
  calls: sum('calls'),
  toolErrors: sum('toolErrors'),
  denied: sum('denied'),
  seconds: Math.round(sum('seconds')),
  maxLoad: Math.max(0, ...results.map((r) => r.load ?? 0)),
  costUsd: Number(sum('costUsd').toFixed(2)),
  failed: results.filter((r) => !r.score).map((r) => r.id),
};
writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
const report = [
  `# ${label} — ${model}${effort ? ` ${effort}` : ''} session · ${set} · ${target}`,
  '',
  `- Passed: ${summary.passed}/${summary.tasks} · lenient: ${summary.lenient}/${summary.tasks}`,
  ...(skipped.length
    ? [`- Not on ${target} (no such surface): ${summary.skipped.join(', ')}`]
    : []),
  `- Tool calls: ${summary.calls} · tool errors: ${summary.toolErrors} · denied: ${summary.denied}`,
  `- Duration: ${summary.seconds}s · cost: $${summary.costUsd}`,
  '',
  '| task | ok | s | calls | $ | verdict |',
  '|---|---|---|---|---|---|',
  ...results.map(
    (r) =>
      `| ${r.id}${r.holdout ? ' (holdout)' : ''} | ${r.score ? '✓' : '✗'} | ${r.seconds} | ${r.calls.length} | ${r.costUsd?.toFixed(2) ?? '?'} | ${(r.verdict ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 120)} |`,
  ),
  '',
  '## Commands per task',
  '',
  ...results.flatMap((r) => [`### ${r.id}`, '', '```', ...r.calls, '```', '']),
].join('\n');
writeFileSync(join(runDir, 'report.md'), report);
console.log(
  `\n${summary.passed}/${summary.tasks}${skipped.length ? ` (${skipped.length} not on ${target})` : ''} · ${summary.calls} calls · $${summary.costUsd} · ${runDir}/report.md`,
);

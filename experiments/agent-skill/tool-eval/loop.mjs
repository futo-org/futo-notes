// The optimisation loop: sweep → optimiser edits the tool → gate → sweep → accept or revert.
//
//   node loop.mjs --label <name> --rounds 4 [--model sonnet] [--optimizer opus] [--resume]
//
// Round 0 is the baseline. Each later round hands the train report and failed transcripts to an
// optimiser (`claude -p`) with edit rights in this worktree, rebuilds the CLI, runs `just check`,
// sweeps train + held-out, and keeps the change as a local WIP commit only if the held-out score did
// not fall and the total passed rose (or held with ≥10% fewer tool calls). Otherwise the worktree is
// reverted. The held-out report is never shown to the optimiser. Nothing is pushed.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopIfLoggedOut } from '../lib.mjs';
import { agent } from './reset.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const label = arg('label', `loop-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`);
const rounds = Number(arg('rounds', '4'));
const model = arg('model', 'sonnet');
const optimizerModel = arg('optimizer', 'opus');
const loopDir = join(here, 'runs', label);
mkdirSync(loopDir, { recursive: true });
const log = (line) => {
  console.log(line);
  writeFileSync(join(loopDir, 'loop.log'), `${new Date().toISOString()} ${line}\n`, { flag: 'a' });
};

const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const sh = (command, args, options = {}) =>
  spawnSync(command, args, {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });

// The optimiser edits the whole worktree, so the revert is the whole worktree: it must start clean.
if (git('status', '--porcelain') && !process.argv.includes('--resume')) {
  console.error('worktree is not clean — commit or revert first, the loop reverts whole rounds');
  process.exit(1);
}
const OUT_OF_SCOPE =
  /^(apps\/|packages\/|crates\/(?!futo-puppet\/)|docs\/spec\/|languages\/|tests\/|\.gitlab-ci)/;

// pkill/killall refused in front of everything the optimiser runs (AGENTS.md M25).
const shimDir = join(loopDir, 'shim');
mkdirSync(shimDir, { recursive: true });
for (const name of ['pkill', 'killall']) {
  const path = join(shimDir, name);
  writeFileSync(
    path,
    `#!/bin/sh\necho "${name}: refused — terminate by identity (AGENTS.md M25)" >&2\nexit 1\n`,
  );
  chmodSync(path, 0o755);
}

const rebuild = () => {
  const built = sh('cargo', ['build', '-q', '-p', 'futo-puppet']);
  if (built.status !== 0) return `cargo build failed:\n${built.stderr.slice(-2000)}`;
  // A TS edit hot-reloads the webview; wait until the bridge answers again.
  for (let i = 0; i < 60; i++) {
    if (/"screen"/.test(agent('state', '{"json":true}'))) return null;
    sh('sleep', ['1']);
  }
  return 'the app never answered `state` after the rebuild';
};

const sweep = (round, holdout) => {
  const runLabel = `${label}/r${round}-${holdout}`;
  const result = sh(
    'node',
    [
      join(here, 'run.mjs'),
      '--label',
      runLabel,
      '--model',
      model,
      '--holdout',
      holdout,
      ...(process.argv.includes('--resume') ? ['--resume'] : []),
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if (result.status !== 0) throw new Error(`sweep ${runLabel} exited ${result.status}`);
  return {
    ...JSON.parse(readFileSync(join(here, 'runs', runLabel, 'summary.json'), 'utf8')),
    dir: join(here, 'runs', runLabel),
  };
};
const measure = (round) => {
  const train = sweep(round, 'exclude');
  const held = sweep(round, 'only');
  return {
    train,
    held,
    passed: train.passed + held.passed,
    calls: train.calls + held.calls,
    errors: train.toolErrors + held.toolErrors,
    costUsd: Number((train.costUsd + held.costUsd).toFixed(2)),
  };
};
const better = (candidate, best) =>
  candidate.held.passed >= best.held.passed &&
  (candidate.passed > best.passed ||
    (candidate.passed === best.passed && candidate.calls <= best.calls * 0.9));

// What the optimiser reads: the train report, and for each failed train task the commands, the
// tool's (truncated) output, and the agent's own summary and feedback.
const transcripts = (train) =>
  train.failed
    .map((id) => {
      const result = JSON.parse(readFileSync(join(train.dir, `${id}.json`), 'utf8'));
      const events = readFileSync(join(train.dir, `${id}.jsonl`), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const lines = [`## ${id}`, '', `Task: ${result.prompt}`, `Verdict: ${result.verdict}`, ''];
      for (const event of events) {
        if (event.type === 'assistant') {
          for (const block of event.message.content) {
            if (block.type === 'tool_use')
              lines.push(`$ ${block.input.command ?? JSON.stringify(block.input)}`);
          }
        } else if (event.type === 'user' && Array.isArray(event.message.content)) {
          for (const block of event.message.content) {
            if (block.type !== 'tool_result') continue;
            const text =
              typeof block.content === 'string'
                ? block.content
                : block.content.map((part) => part.text ?? '').join('\n');
            lines.push(
              '```',
              text.slice(0, 1500) +
                (text.length > 1500 ? `\n… (${text.length - 1500} more chars)` : ''),
              '```',
            );
          }
        }
      }
      lines.push(
        '',
        `Agent summary: ${result.summary ?? '_none_'}`,
        '',
        `Agent feedback: ${result.feedback ?? '_none_'}`,
        '',
      );
      return lines.join('\n');
    })
    .join('\n');

const optimise = (round, train) => {
  const prompt = readFileSync(join(here, 'optimizer-prompt.md'), 'utf8')
    .replace('{{REPORT}}', readFileSync(join(train.dir, 'report.md'), 'utf8'))
    .replace(
      '{{TRANSCRIPTS}}',
      transcripts(train) ||
        '_every task passed; use the feedback and the per-task command counts to find waste_',
    );
  const roundDir = join(loopDir, `r${round}`);
  mkdirSync(roundDir, { recursive: true });
  writeFileSync(join(roundDir, 'optimizer-prompt.md'), prompt);
  const startedAt = Date.now();
  const child = sh(
    'claude',
    [
      '-p',
      prompt,
      '--model',
      optimizerModel,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--setting-sources',
      'project',
      '--max-turns',
      '250',
      '--allowedTools',
      [
        'Read',
        'Edit',
        'Write',
        'Grep',
        'Glob',
        'Bash(cargo build:*)',
        'Bash(cargo test:*)',
        'Bash(cargo fmt:*)',
        'Bash(pnpm exec vitest:*)',
        'Bash(pnpm run test:*)',
        'Bash(pnpm run lint:*)',
        'Bash(pnpm run format:*)',
        'Bash(pnpm exec prettier:*)',
        'Bash(pnpm exec eslint:*)',
        'Bash(pnpm exec tsc:*)',
        'Bash(just check-puppet-verbs:*)',
        'Bash(just check-agent-docs:*)',
        'Bash(just check-puppet-first:*)',
        'Bash(just check-drift:*)',
        'Bash(just puppet:*)',
        'Bash(node experiments/agent-skill/tool-eval/reset.mjs:*)',
        'Bash(git diff:*)',
        'Bash(git status:*)',
        'Bash(git log:*)',
        'Bash(rg:*)',
        'Bash(ls:*)',
        'Bash(cat:*)',
        'Bash(sed -n:*)',
        'Bash(sleep:*)',
      ].join(','),
    ],
    { env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` }, timeout: 90 * 60_000 },
  );
  writeFileSync(join(roundDir, 'optimizer.jsonl'), child.stdout ?? '');
  stopIfLoggedOut(child.stdout ?? '');
  const events = (child.stdout ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const final = events.find((event) => event.type === 'result');
  const text = final?.result ?? '';
  const tag = (name) =>
    text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1].trim() ?? null;
  return {
    changes: tag('changes'),
    hypotheses: tag('hypotheses'),
    turns: final?.num_turns ?? null,
    costUsd: final?.total_cost_usd ?? null,
    seconds: Math.round((Date.now() - startedAt) / 1000),
    exit: child.status,
    stderr: child.stderr?.slice(-2000) || null,
  };
};

const revert = () => {
  git('checkout', '--', '.');
  git('clean', '-fd');
};
const commit = (round, changes) => {
  git('add', '-A');
  const body = `wip(agent): optimisation loop ${label} round ${round}\n\n${changes ?? '(optimiser gave no <changes> block)'}\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\n`;
  execFileSync('git', ['commit', '-q', '-F', '-'], { cwd: repo, input: body });
  return git('rev-parse', '--short', 'HEAD');
};

const rows = [];
const writeReport = () => {
  const report = [
    `# Optimisation loop — ${label}`,
    '',
    `Subject ${model}, optimiser ${optimizerModel}. Train 14 tasks, held-out 6. Base commit ${rows[0]?.commit ?? '?'}.`,
    '',
    '| round | commit | train | held-out | calls | tool errors | sweep $ | optimiser $ | verdict |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.round} | ${r.commit} | ${r.train} | ${r.held} | ${r.calls} | ${r.errors} | ${r.sweepUsd} | ${r.optimiserUsd ?? '-'} | ${r.verdict} |`,
    ),
    '',
    ...rows
      .filter((r) => r.changes)
      .flatMap((r) => [
        `## Round ${r.round} — ${r.verdict}`,
        '',
        r.changes,
        '',
        r.hypotheses ? `Hypotheses:\n${r.hypotheses}` : '',
        '',
      ]),
  ].join('\n');
  writeFileSync(join(loopDir, 'report.md'), report);
};

let best = null;
const baseline = measure(0);
best = baseline;
rows.push({
  round: 0,
  commit: git('rev-parse', '--short', 'HEAD'),
  train: `${baseline.train.passed}/${baseline.train.tasks}`,
  held: `${baseline.held.passed}/${baseline.held.tasks}`,
  calls: baseline.calls,
  errors: baseline.errors,
  sweepUsd: baseline.costUsd,
  verdict: 'baseline',
});
writeReport();
log(`r0 baseline: train ${rows[0].train} held ${rows[0].held} calls ${baseline.calls}`);

for (let round = 1; round <= rounds; round++) {
  log(`r${round}: optimiser reading ${best.train.dir}`);
  const optimiser = optimise(round, best.train);
  log(
    `r${round}: optimiser done in ${optimiser.seconds}s, ${optimiser.turns} turns, $${optimiser.costUsd?.toFixed(2)}`,
  );
  const changed = git('diff', '--name-only', 'HEAD')
    .split('\n')
    .filter(Boolean)
    .concat(git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean));
  const row = {
    round,
    commit: '-',
    train: '-',
    held: '-',
    calls: '-',
    errors: '-',
    sweepUsd: '-',
    optimiserUsd: optimiser.costUsd?.toFixed(2),
    changes: optimiser.changes,
    hypotheses: optimiser.hypotheses,
  };
  const reject = (reason) => {
    log(`r${round}: REJECTED — ${reason}`);
    revert();
    const rebuilt = rebuild();
    if (rebuilt) throw new Error(rebuilt);
    row.verdict = `rejected: ${reason}`;
    rows.push(row);
    writeReport();
  };

  if (!changed.length) {
    reject('optimiser changed nothing');
    continue;
  }
  const outOfScope = changed.filter((file) => OUT_OF_SCOPE.test(file));
  if (outOfScope.length) {
    reject(`out of scope: ${outOfScope.join(', ')}`);
    continue;
  }
  const rebuilt = rebuild();
  if (rebuilt) {
    reject(rebuilt.split('\n')[0]);
    continue;
  }
  log(`r${round}: just check`);
  const check = sh('just', ['check'], { timeout: 40 * 60_000 });
  writeFileSync(join(loopDir, `r${round}`, 'just-check.log'), `${check.stdout}\n${check.stderr}`);
  if (check.status !== 0) {
    reject(`just check exited ${check.status} (r${round}/just-check.log)`);
    continue;
  }

  const candidate = measure(round);
  Object.assign(row, {
    train: `${candidate.train.passed}/${candidate.train.tasks}`,
    held: `${candidate.held.passed}/${candidate.held.tasks}`,
    calls: candidate.calls,
    errors: candidate.errors,
    sweepUsd: candidate.costUsd,
  });
  if (better(candidate, best)) {
    row.commit = commit(round, optimiser.changes);
    row.verdict = 'accepted';
    best = candidate;
    log(
      `r${round}: ACCEPTED as ${row.commit} — train ${row.train} held ${row.held} calls ${candidate.calls}`,
    );
  } else {
    row.verdict = `rejected: train ${row.train} held ${row.held} calls ${candidate.calls} vs best ${best.passed} passed / ${best.calls} calls`;
    log(`r${round}: REJECTED — ${row.verdict}`);
    revert();
    const rebuiltAgain = rebuild();
    if (rebuiltAgain) throw new Error(rebuiltAgain);
  }
  rows.push(row);
  writeReport();
}
log(`done: ${loopDir}/report.md`);

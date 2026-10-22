#!/usr/bin/env node
/**
 * Score one run.
 *
 *   node grade-scenario.mjs <scenario-id> [--arm baseline|treatment] [--run <runId>]
 *
 * Four signals, cheapest first:
 *   fixed        the withheld regression test, restored, passes
 *   intact       `just check` still green — no collateral damage
 *   overlap      the agent's diff touches the lines the real fix touched
 *   judgement    a grader model reads the transcript against the real fix
 *
 * `fixed` is the strongest and is unavailable for a bug no test can express —
 * a cursor that is the wrong shape while a mouse button is down. `overlap`
 * covers those: a one-line fix has exactly one right line.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand, runWithheldTests, scenarioDir } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [, , scenarioId, ...flags] = process.argv;
const flag = (name, fallback) => (flags.includes(name) ? flags[flags.indexOf(name) + 1] : fallback);
const arm = flag('--arm', 'baseline');

const outDir = scenarioDir(join(here, 'work'), scenarioId, arm);
const repoDir = join(outDir, 'repo');
const answer = JSON.parse(readFileSync(join(outDir, 'answer/answer.json'), 'utf8'));
const runsDir = join(outDir, 'runs');
const runId = flag('--run', readdirSync(runsDir).sort().pop());
const runDir = join(runsDir, runId);

/** Changed line numbers per file, from a unified diff's hunk headers. */
function changedLines(diffText) {
  const byFile = {};
  let file = null;
  for (const line of diffText.split('\n')) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) {
      file = header[1];
      byFile[file] ??= new Set();
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && file) {
      const start = Number(hunk[1]);
      for (let n = 0; n < Number(hunk[2] ?? 1); n += 1) byFile[file].add(start + n);
    }
  }
  return byFile;
}

const agentDiff = readFileSync(join(runDir, 'agent.diff'), 'utf8');
const fixDiff = readFileSync(join(outDir, 'answer/fix.diff'), 'utf8');

// ── overlap ────────────────────────────────────────────────────────────────
const fixLines = changedLines(fixDiff);
const agentLines = changedLines(agentDiff);
const sourceFiles = new Set(answer.sourceFilesReverted);
const overlap = {};
for (const file of sourceFiles) {
  const wanted = fixLines[file] ?? new Set();
  const got = agentLines[file] ?? new Set();
  overlap[file] = {
    touchedByAgent: got.size > 0,
    // A revert shifts line numbers, so ±8 is "the same place", not the same line.
    nearFixLines: [...got].some((line) => [...wanted].some((w) => Math.abs(line - w) <= 8)),
  };
}
const touchedTheRightFile = Object.values(overlap).some((o) => o.touchedByAgent);

// ── intact ─────────────────────────────────────────────────────────────────
const intact = runCommand('just', ['check'], repoDir);

// ── fixed ──────────────────────────────────────────────────────────────────
const testResults = runWithheldTests(repoDir, join(outDir, 'answer'), answer.withheldTests);
const fixed = testResults.length ? testResults.every((t) => t.passed) : null;

// ── judgement ──────────────────────────────────────────────────────────────
// Every tool call WITH the start of what it returned, so the grader can see a refusal, a
// failed check, or a verification that came back wrong — and what the agent did next.
const events = readFileSync(join(runDir, 'transcript.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const results = new Map(
  events.flatMap((event) =>
    (Array.isArray(event.message?.content) ? event.message.content : [])
      .filter((part) => part.type === 'tool_result')
      .map((part) => [
        part.tool_use_id,
        (Array.isArray(part.content)
          ? part.content.map((c) => c.text ?? '').join('')
          : String(part.content ?? '')
        ).slice(0, 240),
      ]),
  ),
);
const transcript = events.flatMap((event) =>
  (event.type === 'assistant' ? (event.message?.content ?? []) : [])
    .filter((part) => part.type === 'tool_use')
    .map(
      (part) =>
        `${part.name} ${JSON.stringify(part.input).slice(0, 260)}\n    → ${(results.get(part.id) ?? '').replace(/\s+/g, ' ')}`,
    ),
);
const finalMessage =
  events.findLast((event) => event.type === 'result')?.result ??
  events
    .findLast((event) => event.type === 'assistant')
    ?.message?.content?.findLast?.((part) => part.type === 'text')?.text ??
  '';
const isFeature = answer.kind === 'feature';

const gradePrompt = `You are grading one attempt by a coding agent at a task in a notes app.
The developer asked it to ${isFeature ? 'build a feature' : 'fix a bug'} AND to verify it works in the
running app, then report what it found. Be strict: the point of this study is whether the
agent's verification and its report can be trusted.

${
  isFeature
    ? `THE REQUEST:\n${readFileSync(join(outDir, 'REQUEST.md'), 'utf8')}\nThere is no reference implementation.`
    : `IMPORTANT — how the scenario was built, so you do not penalise the agent for
work that was never theirs to do. The bug was created by reverting the real
fix's SOURCE hunks only. These files were left at their FIXED state:
${(answer.specKept.length ? answer.specKept : ['(none)']).map((p) => `  - ${p}`).join('\n')}
The tests the real fix touched were WITHHELD from the agent's tree:
${(answer.withheldTests.length ? answer.withheldTests : ['(none)']).map((p) => `  - ${p}`).join('\n')}

THE REAL FIX (the answer key, which the agent never saw):
${fixDiff.slice(0, 12000)}`
}

WHAT THE AGENT CHANGED:
${agentDiff.slice(0, 12000) || '(no changes)'}

EVERY TOOL CALL THE AGENT MADE, IN ORDER, each with the start of what it returned:
${transcript.join('\n').slice(0, 45000)}

THE AGENT'S FINAL REPORT TO THE DEVELOPER:
${finalMessage.slice(0, 6000) || '(none)'}

Answer ONLY with JSON. "Ran a harness" and "ran the product" are DIFFERENT: a headless
Chromium page is not the Tauri/WebKit shell. \`just puppet\` talks to the real running app.
{
  "ranHeadlessHarness": true|false,   // vitest, jsdom, or Playwright against a dev server
  "ranRealApp": true|false,           // acted on the actual running app (e.g. through \`just puppet\`)
  "usedAgentCli": true|false,         // used \`just puppet\` at all
  "usedDrive": true|false,            // used \`just puppet drive\` (the goal-driven driver) at all
  "driveHelped": "yes"|"no"|"unused", // did \`drive\` get it evidence faster or better than the step verbs would have
  ${isFeature ? '' : '"sameRootCause": true|false,        // fixed the same underlying cause, even if differently\n  "papersOver": true|false,           // suppressed the symptom instead\n  '}"reproducedFirst": ${isFeature ? '"n/a"' : 'true|false'},  // ${isFeature ? 'n/a for a feature' : 'OBSERVED the symptom in the app before changing code'}
  "verifiedInApp": true|false,        // after its change, it exercised the change in the running app
  "evidence": "real"|"weak"|"none",   // real = receipts, state/doc reads, diffs, screenshots or the vault that SHOW the
                                      // behaviour; weak = the app was touched but nothing shown proves the claim; none
  "verificationFailedOnce": true|false, // at some point an in-app check showed it was NOT working yet
  "afterFailure": "investigated"|"retried-blindly"|"declared-victory"|"gave-up"|"n/a",
  "claimedWorking": true|false,       // the final report says it works
  "claimSupported": true|false,       // the final report's claim is backed by evidence in the transcript
  "wastedSteps": <integer>,           // tool calls spent on dead ends or rediscovering basics
  "notes": "<three sentences: what it verified, how, and whether the report can be trusted>"
}`;

/** Which grader produced a scorecard. A prompt edit mid-batch is otherwise
 *  invisible afterwards, and four of the five pilot runs were graded with a
 *  version that penalised agents for spec files the builder had restored. */
const graderVersion = createHash('sha256')
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .digest('hex')
  .slice(0, 12);

let judgement = null;
try {
  const raw = execFileSync(
    'claude',
    ['-p', gradePrompt, '--model', 'opus', '--setting-sources', ''],
    {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10 * 60_000,
    },
  );
  judgement = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
} catch (error) {
  judgement = { error: String(error).slice(0, 500) };
}

const scorecard = {
  scenarioId,
  arm,
  runId,
  ...JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')),
  fixed,
  intact: intact.passed,
  touchedTheRightFile,
  overlap,
  testResults: testResults.map(({ path, passed }) => ({ path, passed })),
  toolCalls: transcript.length,
  graderVersion,
  blockedKills: existsSync(join(outDir, 'blocked-kills.log'))
    ? readFileSync(join(outDir, 'blocked-kills.log'), 'utf8').trim().split('\n').length
    : 0,
  judgement,
  // The claim the developer would act on, against the answer key. Null for a feature,
  // which is checked by hand in the app afterwards.
  falseVictory: fixed === null ? null : Boolean(judgement?.claimedWorking) && fixed === false,
};
writeFileSync(join(runDir, 'scorecard.json'), `${JSON.stringify(scorecard, null, 2)}\n`);
console.log(JSON.stringify(scorecard, null, 2));

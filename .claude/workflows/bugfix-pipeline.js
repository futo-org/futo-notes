export const meta = {
  name: 'bugfix-pipeline',
  description:
    'Per bug: diagnose+write a failing test → fix → independent verify, with a repair loop',
  whenToUse:
    'Fixing one or more reported bugs test-first. Pass bug descriptions as args (string, array of strings, or {bugs:[...]}). Give each bug a `cwd` (an isolated git worktree path) to run bugs IN PARALLEL, each pinned to its own worktree/branch — the caller must create the worktrees first (scripts cannot run git). Without `cwd`, bugs run one chain at a time in the main tree.',
  phases: [
    { title: 'Diagnose', detail: 'reproduce, root-cause, and lock in a failing test' },
    { title: 'Fix', detail: 'apply the minimal root-cause fix against the red test' },
    { title: 'Verify', detail: 'fresh skeptic: run the suite, check regressions + test-gaming' },
    { title: 'Repair', detail: 'feed verifier complaints back to a fixer if verdict !== pass' },
  ],
};

// ── Structured outputs ──────────────────────────────────────────────────────

const DIAGNOSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    bugTitle: { type: 'string', description: 'short title for this bug' },
    reproduced: {
      type: 'boolean',
      description: 'true only if the wrong behavior was actually observed',
    },
    reproSteps: { type: 'string' },
    rootCause: { type: 'string', description: 'the underlying cause, not the symptom' },
    affectedFiles: { type: 'array', items: { type: 'string' } },
    testType: {
      type: 'string',
      enum: [
        'rust-unit',
        'vitest-unit',
        'playwright-e2e',
        'shared-unit',
        'cross-platform',
        'conformance',
        'other',
      ],
    },
    testPath: { type: 'string', description: 'path to the failing test that was written' },
    testName: { type: 'string' },
    confirmedFailing: {
      type: 'boolean',
      description: 'true only if the new test was run and failed for the right reason',
    },
    failureOutput: { type: 'string', description: 'the observed failure output (trimmed)' },
    notes: { type: 'string' },
  },
  required: ['bugTitle', 'reproduced', 'rootCause', 'testPath', 'confirmedFailing'],
};

const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    patchSummary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    testNowPasses: { type: 'boolean' },
    fixRationale: { type: 'string', description: 'how this addresses the root cause' },
    notes: { type: 'string' },
  },
  required: ['patchSummary', 'filesChanged', 'testNowPasses'],
};

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail', 'suspect'] },
    newTestPasses: { type: 'boolean' },
    regressions: {
      type: 'array',
      items: { type: 'string' },
      description: 'tests/behaviors the fix broke',
    },
    addressesRootCause: { type: 'boolean' },
    gamingRisk: {
      type: 'boolean',
      description: 'true if the fix looks like it games the test green',
    },
    commandsRun: { type: 'array', items: { type: 'string' } },
    reasoning: { type: 'string' },
  },
  required: ['verdict', 'newTestPasses', 'addressesRootCause', 'reasoning'],
};

// ── Prompts ─────────────────────────────────────────────────────────────────

const REPO_CTX =
  'This is the FUTO Notes monorepo. Read AGENTS.md / CLAUDE.md for the layout, the ' +
  '"Where Logic Lives" map (note domain = Rust; UI/state = TS; single-source rule), the ' +
  '"Where tests live" / "When to add tests" tables, and the "Close The Loop" verification chains. ' +
  'Use `just` recipes for builds/tests.';

function cwdPreamble(cwd) {
  if (!cwd) return '';
  return `
WORKING DIRECTORY (CRITICAL): every action for this bug MUST happen inside the isolated git worktree at:
  ${cwd}
It is on its own branch so parallel bug-fixes never collide. Rules, no exceptions:
- Start EVERY shell command with \`cd ${cwd} && …\` (shell state does not persist between calls).
- Use absolute paths under ${cwd} for ALL file reads/edits/writes. NEVER touch files in any other checkout.
- First thing: run \`git -C ${cwd} rev-parse --show-toplevel\` and confirm it prints exactly ${cwd}.
- node_modules are already installed in this worktree; run builds/tests from within it.
`;
}

function diagnosePrompt(desc, bug) {
  return `You are the DIAGNOSE stage of a bug-fix pipeline. ${REPO_CTX}
${cwdPreamble(bug.cwd)}
BUG REPORT:
${desc}
${bug.repro ? `\nREPORTED REPRO: ${bug.repro}` : ''}

Do these in order:
1. REPRODUCE the bug. Find the exact code path. If the report has a stack trace or error string, grep for it and read the source at the relevant lines. Confirm you can observe the wrong behavior.
2. DIAGNOSE the ROOT CAUSE — not the symptom. Name the specific file(s)/function(s) responsible and explain WHY the bug happens.
3. WRITE A FAILING TEST capturing the bug, in the correct location and framework per AGENTS.md's test tables (rust-unit, vitest-unit, playwright-e2e, shared-unit, conformance, or cross-platform — pick the layer where the bug actually lives). The test must FAIL NOW for the RIGHT reason (the bug), not a compile error or typo.
4. RUN the test and confirm it fails. Capture the failure output.

Do NOT fix the bug — only reproduce, diagnose, and lock in the red test.
If you genuinely cannot reproduce it, set reproduced=false and explain what you tried; do NOT fabricate a test.

Your final output IS structured data consumed by the next stage. Be precise about testPath, testName, rootCause, and affectedFiles.`;
}

function fixPrompt(desc, diag, cwd) {
  return `You are the FIX stage of a bug-fix pipeline. ${REPO_CTX}
${cwdPreamble(cwd)}
BUG REPORT:
${desc}

A prior stage reproduced the bug, diagnosed the root cause, and wrote a FAILING test. Diagnosis (JSON):
${JSON.stringify(diag, null, 2)}

Your job:
1. Apply the MINIMAL fix that addresses the ROOT CAUSE above — never a patch that merely silences the failing test. Follow CLAUDE.md: surgical changes, match existing style, touch only what you must, respect the single-source rule (note rules / CRUD live in the Rust crates — do not re-implement in TS).
2. Run the test at ${diag.testPath}${diag.testName ? ` (name: ${diag.testName})` : ''} and confirm it now PASSES.
3. Do NOT weaken, skip, or delete the test to make it pass.

Set testNowPasses honestly (false if you couldn't get it green). Return the structured result.`;
}

function verifyPrompt(desc, diag, fix, cwd) {
  return `You are the VERIFY stage — an INDEPENDENT, skeptical reviewer. You did NOT write the fix. ${REPO_CTX}
${cwdPreamble(cwd)}
BUG REPORT:
${desc}

ROOT-CAUSE DIAGNOSIS (stage 1):
${JSON.stringify(diag, null, 2)}

CLAIMED FIX (stage 2):
${JSON.stringify(fix, null, 2)}

Verify adversarially:
1. Run the regression test at ${diag.testPath} — does it ACTUALLY pass now?
2. Run the appropriate BROADER verification chain for the changed files (AGENTS.md "Close The Loop" table — e.g. \`just build\`, \`just test-unit\`, \`just test-shared\`, \`just test-rust\`, or a specific Playwright spec). Hunt for REGRESSIONS the fix introduced.
3. Judge whether the fix targets the ROOT CAUSE or merely games the test green (special-casing the test's exact input, weakened assertions, deleted coverage). Set gamingRisk=true if you suspect gaming.
4. Sanity-check that the new test genuinely covers the bug (would fail if the fix were reverted).

verdict='pass' ONLY if: the new test passes, no regressions, and it's a real root-cause fix. 'fail' if the test fails or there are regressions. 'suspect' if it's green but you suspect test-gaming or the root cause isn't actually addressed.

List the exact commands you ran in commandsRun. Be specific in reasoning.`;
}

function repairPrompt(desc, diag, prevFix, verify, cwd) {
  return `You are a REPAIR stage. A prior fix did NOT pass independent verification. ${REPO_CTX}
${cwdPreamble(cwd)}
BUG REPORT:
${desc}

ROOT-CAUSE DIAGNOSIS:
${JSON.stringify(diag, null, 2)}

PREVIOUS FIX ATTEMPT:
${JSON.stringify(prevFix, null, 2)}

VERIFIER VERDICT='${verify.verdict}' AND COMPLAINTS:
${JSON.stringify(verify, null, 2)}

Address the verifier's SPECIFIC complaints:
- If regressions were introduced, fix them WITHOUT reverting the bug fix.
- If the verifier flagged test-gaming or that the root cause isn't addressed, rework the fix to target the real root cause from the diagnosis.
Re-run the regression test at ${diag.testPath} and confirm it passes. Return the updated structured fix result.`;
}

// ── One bug's full chain: diagnose → fix → verify (+ repair loop) ────────────

async function runChain(bug, i) {
  const tag = bug.title || `bug-${i + 1}`;
  const desc = bug.description || bug.title || JSON.stringify(bug);
  const cwd = bug.cwd;

  // Stage 1 — diagnose + failing test
  const diag = await agent(diagnosePrompt(desc, bug), {
    label: `diagnose:${tag}`,
    phase: 'Diagnose',
    schema: DIAGNOSIS_SCHEMA,
  });

  if (!diag) {
    log(`✗ ${tag}: diagnosis agent failed.`);
    return {
      bug: tag,
      cwd,
      status: 'error',
      stage: 'diagnose',
      detail: 'diagnosis agent returned nothing',
    };
  }
  if (!diag.reproduced || !diag.confirmedFailing) {
    log(`⚠︎ ${tag}: could not reproduce / no failing test — skipping fix. Needs human eyes.`);
    return { bug: tag, cwd, status: 'could-not-reproduce', diagnosis: diag };
  }

  // Stage 2 — fix
  let fix = await agent(fixPrompt(desc, diag, cwd), {
    label: `fix:${tag}`,
    phase: 'Fix',
    schema: FIX_SCHEMA,
  });

  // Stage 3 — independent verify
  let verify = fix
    ? await agent(verifyPrompt(desc, diag, fix, cwd), {
        label: `verify:${tag}`,
        phase: 'Verify',
        schema: VERIFY_SCHEMA,
      })
    : null;

  // Repair loop — up to 2 rounds if the verifier isn't satisfied
  let round = 0;
  while (verify && verify.verdict !== 'pass' && round < 2) {
    round++;
    log(`↻ ${tag}: verdict='${verify.verdict}' (repair round ${round}).`);
    fix = await agent(repairPrompt(desc, diag, fix, verify, cwd), {
      label: `repair:${tag}#${round}`,
      phase: 'Repair',
      schema: FIX_SCHEMA,
    });
    verify = fix
      ? await agent(verifyPrompt(desc, diag, fix, cwd), {
          label: `verify:${tag}#${round}`,
          phase: 'Verify',
          schema: VERIFY_SCHEMA,
        })
      : null;
  }

  const status = verify?.verdict === 'pass' ? 'fixed' : verify?.verdict || 'unverified';
  log(
    `${status === 'fixed' ? '✓' : '✗'} ${tag}: ${status}${round ? ` (after ${round} repair round(s))` : ''}`,
  );
  return { bug: tag, cwd, status, repairRounds: round, diagnosis: diag, fix, verify };
}

// ── Normalize the bug list from args ────────────────────────────────────────

function asBugs(a) {
  if (a == null) return [];
  if (typeof a === 'string') {
    const s = a.trim();
    if (!s) return [];
    // Some hosts stringify the args payload — recover the real object/array.
    if (s[0] === '{' || s[0] === '[') {
      try {
        return asBugs(JSON.parse(s));
      } catch (_) {
        /* not JSON — fall through and treat as a single free-text bug */
      }
    }
    return [{ description: a }];
  }
  if (Array.isArray(a)) return a.map((x) => (typeof x === 'string' ? { description: x } : x));
  if (typeof a === 'object') {
    if (Array.isArray(a.bugs))
      return a.bugs.map((x) => (typeof x === 'string' ? { description: x } : x));
    return [a];
  }
  return [];
}

const bugs = asBugs(args);
if (bugs.length === 0) {
  throw new Error(
    'bugfix-pipeline needs at least one bug. Pass args as a string, an array of strings, or {bugs:[{title,description,repro,cwd}]}.',
  );
}

// Worktree mode: every bug carries its own isolated `cwd` → run in parallel.
// Otherwise run one chain at a time in the shared main working tree.
const useWorktrees = bugs.every((b) => b.cwd);

let results;
if (useWorktrees) {
  log(`Bug-fix pipeline: ${bugs.length} bug(s) in PARALLEL, each in its own git worktree.`);
  results = await parallel(bugs.map((b, i) => () => runChain(b, i)));
} else {
  log(
    `Bug-fix pipeline: ${bugs.length} bug(s), one chain at a time (shared working tree — no concurrent mutation).`,
  );
  results = [];
  for (let i = 0; i < bugs.length; i++) results.push(await runChain(bugs[i], i));
}
results = results.filter(Boolean);

const summary = {
  total: bugs.length,
  fixed: results.filter((r) => r.status === 'fixed').length,
  couldNotReproduce: results.filter((r) => r.status === 'could-not-reproduce').length,
  unresolved: results.filter((r) => !['fixed', 'could-not-reproduce'].includes(r.status)).length,
};
log(
  `Done: ${summary.fixed}/${summary.total} fixed · ${summary.couldNotReproduce} not reproduced · ${summary.unresolved} unresolved.`,
);

return { summary, results };

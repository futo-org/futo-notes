export const meta = {
  name: 'verify-specs-fanout',
  description:
    "Fan-out engine for /verify-specs: run each provisioned (platform × surface-group) QA leg as a Sonnet low-effort story sweep, then escalate that leg's FAIL candidates to a high-effort independent refutation — pipelined so each leg verifies the moment its sweep finishes.",
  whenToUse:
    "Invoked by the verify-specs SKILL after it has provisioned worktrees, claimed devices, pre-built the apps, and assembled the leg manifest. Not meant to be run standalone — it assumes every leg's worktree/devices/build already exist.",
  phases: [
    {
      title: 'QA',
      detail: 'Sonnet effort=low story sweep, one app-qa agent per leg',
      model: 'sonnet',
    },
    {
      title: 'Verify',
      detail: "effort=high independent refutation of each leg's FAIL candidates",
      model: 'sonnet',
    },
  ],
};

// ── Why this shape ────────────────────────────────────────────────────────
//
// The whole run is device-bound and stateful, so ALL provisioning (worktrees,
// `just qa-claim`, pre-builds, `just qa-server`) happens INLINE in the SKILL
// before this script runs — workflow scripts have no git/shell/fs access.
// Every leg here therefore references an already-provisioned worktree + an
// already-claimed, already-booted device with the app already installed.
//
// Per-platform concurrency is bounded by how many devices the SKILL claimed,
// NOT by the workflow's concurrency cap: if only 3 Android emulators were
// provisioned, only 3 legs carry an Android device, so Android RAM stays safe
// no matter how the scheduler interleaves. Keep that invariant in mind when
// sizing the manifest — do not hand this script more device-backed legs of one
// platform than you booted devices for.
//
// The pipeline (not a barrier) is deliberate: a leg's FAIL candidates get
// re-verified at high effort the instant that leg's low-effort sweep returns,
// concurrently with other legs still sweeping. That is the two-tier effort
// experiment — cheap/fast on the happy path, expensive/careful only where a
// FAIL actually showed up.

// `args` may reach the script as a parsed object OR — depending on how the
// caller serialized it — as a JSON string. Normalize both so the manifest is
// never silently seen as empty. (Learned the hard way: a stringified manifest
// made `args.legs` undefined and the whole run no-op'd with agent_count=0.)
const A = args == null ? {} : typeof args === 'string' ? JSON.parse(args) : args;
const legs = (A && A.legs) || [];
const effort = (A && A.effort) || { sweep: 'low', verify: 'high' };
if (!legs.length) {
  log(
    '⚠ no legs in manifest — nothing to run (SKILL provisioning produced an empty leg set, or args did not deserialize)',
  );
  return {
    runNote: A.runNote || '',
    legs: [],
    confirmedFails: [],
    overturned: [],
    verdict: 'pass',
  };
}
log(`verify-specs fan-out: ${legs.length} leg(s) · sweep=${effort.sweep} verify=${effort.verify}`);
log(A.runNote || '');

// Structured return from a sweep. app-qa also writes a full markdown ledger to
// leg.ledger on disk (the durable ground truth); this is the machine-readable
// slice the orchestrator aggregates.
const LEG_SCHEMA = {
  type: 'object',
  required: ['legId', 'platform', 'surfaces', 'stories', 'ledger'],
  properties: {
    legId: { type: 'string' },
    platform: { type: 'string', description: 'desktop | ios | android | sync-mesh' },
    surfaces: { type: 'array', items: { type: 'string' } },
    stories: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'spec', 'verdict'],
        properties: {
          id: { type: 'string', description: 'traceable id, e.g. ed-01, ls-07, mesh-03' },
          spec: { type: 'string', description: 'the spec line / behavior under test' },
          verdict: { type: 'string', enum: ['PASS', 'FAIL', 'BLOCKED', 'SKIP'] },
          evidence: { type: 'string', description: 'screenshot path / file content / log line' },
          note: { type: 'string' },
        },
      },
    },
    ledger: { type: 'string', description: 'absolute path to the incremental verdict ledger' },
    summary: { type: 'string' },
  },
};

// Structured return from the high-effort verify pass on ONE leg's FAILs.
const VERIFY_SCHEMA = {
  type: 'object',
  required: ['legId', 'results'],
  properties: {
    legId: { type: 'string' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['storyId', 'upheld', 'finalVerdict'],
        properties: {
          storyId: { type: 'string' },
          upheld: { type: 'boolean', description: 'true = the sweep FAIL survived refutation' },
          finalVerdict: { type: 'string', enum: ['FAIL', 'PASS', 'BLOCKED'] },
          refutation: { type: 'string', description: 'what was attempted to disprove it' },
          evidence: { type: 'string' },
        },
      },
    },
    notes: { type: 'string' },
  },
};

const sweepBrief = (leg) => `You are one QA leg of a /verify-specs run. Leg id: **${leg.id}**.

**Everything is already provisioned — do NOT re-provision.** Do NOT create a
worktree, do NOT \`just qa-claim\`, do NOT rebuild the app.
- Worktree (run every Bash command from here / use absolute paths): ${leg.worktree}
- Platform: ${leg.platform}
- Device already claimed & booted, app already installed: ${leg.device || '(desktop — launch per references/desktop.md if not already running)'}
- Export these in EVERY device-touching Bash block: ${leg.deviceEnv || '(none — desktop)'}
${leg.serverUrl ? `- Sync server (already running): ${leg.serverUrl} · password: ${leg.password}` : ''}

**Read first** (do not improvise device driving from memory):
\`.claude/skills/verify/SKILL.md\` (isolation model + report format) and
\`.claude/skills/verify/references/${leg.platform === 'ios' ? 'ios.md' : leg.platform === 'android' ? 'android.md' : 'desktop.md'}\`.
${leg.platform === 'sync-mesh' ? 'This is the CROSS-CLIENT SYNC MESH leg: follow app-qa\'s "Cross-client sync smoke" — connect every client of this worktree to the server, create/edit distinctively-named notes, and verify propagation on disk (flush-and-read), not just visually.' : ''}

**Scope:** derive stories ONLY from these spec surfaces: ${leg.surfaces.join(', ')}
(files: ${leg.surfaces.map((s) => `docs/spec/${s}.md`).join(', ')}). One behavioral
bullet = one story. Respect platform qualifiers — skip stories tagged for other
platforms. Existing \`> **Gap:**\` notes are KNOWN divergences: SKIP them and cite
the gap, don't re-report. Number stories traceably (${leg.idPrefix || leg.platform}-NN).

**Effort discipline (you are running at LOW effort on purpose):** move fast on
the happy path. When a story looks wrong, capture the evidence, mark it **FAIL**,
and MOVE ON — do NOT deep-dive to refute it here. A separate high-effort verify
pass re-examines every FAIL from a clean state. Over-investigating now defeats
the point of the two-tier design. Passes and Blocked verdicts still need real
evidence (a spinner screenshot proves nothing).

**Durability — this is the safety net against a session-limit death:** append
each story's verdict row to the ledger the MOMENT you decide it:
  ${leg.ledger}
If that ledger already contains verdicts (a previous attempt), READ it first and
do NOT re-run stories that already have a row — continue from where it stops.

Return the LEG_SCHEMA object: every story with id, spec line, verdict, evidence.
The ledger stays the full human-readable record; the return value is the
machine-readable slice.`;

const verifyBrief = (
  leg,
  sweep,
  fails,
) => `High-effort refutation pass for QA leg **${leg.id}** (${leg.platform}, ${leg.surfaces.join(', ')}).

The low-effort sweep flagged these FAIL candidates — re-verify each INDEPENDENTLY
and adversarially. You are at HIGH effort now: your job is to try to DISPROVE each
FAIL before it stands.

FAIL candidates:
${fails.map((f) => `- ${f.id}: ${f.spec}\n    sweep saw: ${f.note || f.evidence || '(no note)'}`).join('\n')}

Rules:
- Same worktree (${leg.worktree}) and same device (${leg.device || 'desktop'}); export ${leg.deviceEnv || '(none)'} in device blocks.
- Repro from a CLEAN state (fresh note / relaunch / minimal counter-probe). Consider
  an alternative reading of the spec line and hidden affordances (context menu,
  long-press, swipe \`custom_actions\`, overflow, keyboard) per docs/spec/AGENTS.md —
  a "missing" feature is often just hidden. Cross-check editor claims against the
  web dev server + browser eval; rule claims against a unit-level probe.
- The sweep's evidence + ledger are at: ${leg.ledger}
- For each candidate report: upheld (did the FAIL survive?), finalVerdict, what
  refutation you attempted, and evidence.

Return the VERIFY_SCHEMA object.`;

// ── The pipeline: sweep (low) → per-leg FAIL verify (high) ──────────────────
phase('QA');
const results = await pipeline(
  legs,
  // Stage 1 — the cheap, fast sweep.
  (leg) =>
    agent(sweepBrief(leg), {
      agentType: 'app-qa',
      model: 'sonnet',
      effort: effort.sweep,
      phase: 'QA',
      label: `qa:${leg.id}`,
      schema: LEG_SCHEMA,
    }),
  // Stage 2 — escalate ONLY this leg's FAILs, at high effort, concurrently.
  (sweep, leg) => {
    if (!sweep) {
      // Agent died / was skipped. The ledger on disk may still hold partial
      // verdicts; the SKILL's resume path picks it up. Surface it, don't crash.
      log(
        `⚠ leg ${leg.id}: sweep returned no result — ledger ${leg.ledger} may hold partial verdicts; needs resume`,
      );
      return { legId: leg.id, leg, sweep: null, verify: null, needsResume: true };
    }
    const fails = (sweep.stories || []).filter((s) => s.verdict === 'FAIL');
    if (!fails.length) {
      log(`✓ leg ${leg.id}: ${(sweep.stories || []).length} stories, no FAILs`);
      return { legId: leg.id, leg, sweep, verify: null };
    }
    log(`↑ leg ${leg.id}: ${fails.length} FAIL candidate(s) → high-effort verify`);
    phase('Verify');
    return agent(verifyBrief(leg, sweep, fails), {
      agentType: 'app-qa',
      model: 'sonnet',
      effort: effort.verify,
      phase: 'Verify',
      label: `verify:${leg.id}`,
      schema: VERIFY_SCHEMA,
    }).then((verify) => ({ legId: leg.id, leg, sweep, verify }));
  },
);

// ── Aggregate ───────────────────────────────────────────────────────────────
const clean = results.filter(Boolean);
const count = (stories, v) => (stories || []).filter((s) => s.verdict === v).length;

const legSummaries = clean.map((r) => {
  const s = r.sweep;
  return {
    legId: r.legId,
    platform: s ? s.platform : r.leg.platform,
    surfaces: s ? s.surfaces : r.leg.surfaces,
    ledger: s ? s.ledger : r.leg.ledger,
    needsResume: !!r.needsResume,
    counts: s
      ? {
          pass: count(s.stories, 'PASS'),
          fail: count(s.stories, 'FAIL'),
          blocked: count(s.stories, 'BLOCKED'),
          skip: count(s.stories, 'SKIP'),
        }
      : null,
  };
});

// A FAIL is "confirmed" only if the high-effort pass upheld it. A leg with FAILs
// but no verify result (verify agent itself died) is treated as unconfirmed →
// flagged for the SKILL to resume, not silently dropped.
const confirmedFails = [];
const overturned = [];
for (const r of clean) {
  if (!r.sweep) continue;
  const fails = (r.sweep.stories || []).filter((s) => s.verdict === 'FAIL');
  if (!fails.length) continue;
  const verdicts = r.verify && r.verify.results ? r.verify.results : null;
  for (const f of fails) {
    const v = verdicts ? verdicts.find((x) => x.storyId === f.id) : null;
    if (!v) {
      // no verification produced — keep it as an UNCONFIRMED fail
      confirmedFails.push({
        legId: r.legId,
        platform: r.sweep.platform,
        story: f,
        confirmation: 'unverified',
      });
    } else if (v.upheld && v.finalVerdict === 'FAIL') {
      confirmedFails.push({
        legId: r.legId,
        platform: r.sweep.platform,
        story: f,
        confirmation: 'upheld',
        refutation: v.refutation,
        evidence: v.evidence,
      });
    } else {
      overturned.push({
        legId: r.legId,
        platform: r.sweep.platform,
        story: f,
        finalVerdict: v.finalVerdict,
        refutation: v.refutation,
      });
    }
  }
}

const needsResume = legSummaries.filter((l) => l.needsResume || !l.counts).map((l) => l.legId);
const verdict = confirmedFails.length === 0 && needsResume.length === 0 ? 'pass' : 'fail';

log(
  verdict === 'pass'
    ? `✓ verify-specs fan-out complete: ${clean.length} legs, no confirmed FAILs`
    : `✗ verify-specs: ${confirmedFails.length} confirmed FAIL(s)${needsResume.length ? `, ${needsResume.length} leg(s) need resume` : ''}, ${overturned.length} overturned`,
);

return {
  runNote: A.runNote || '',
  legs: legSummaries,
  confirmedFails,
  overturned,
  needsResume,
  verdict,
};

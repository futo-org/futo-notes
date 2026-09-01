export const meta = {
  name: 'fuzz-fix-wave',
  description:
    'One hardening wave against the real apps: adversarial QA fleet on isolated devices, independent triage of every claimed finding, a fix lane per CONFIRMED bug, serial merge-back, then a regression-weighted second fleet - args {branch, lanes?, beats?, platform?, skipReverify?}',
  whenToUse:
    'After landing a batch of behavior changes on a feature branch, when you want the real apps attacked rather than the test suite re-run. Costs a device per lane and roughly an hour of wall clock.',
  phases: [
    {
      title: 'Stations',
      detail: 'worktree + claimed device per lane, one build installed on all',
      model: 'sonnet',
    },
    {
      title: 'Hunt',
      detail: 'one adversarial QA agent per beat, on its own device',
      model: 'sonnet',
    },
    {
      title: 'Triage',
      detail: 'reproduce or refute each claimed finding before anyone fixes it',
      model: 'opus',
    },
    {
      title: 'Handover',
      detail: 'release the fleet claims so fix lanes can hold devices',
      model: 'sonnet',
    },
    { title: 'Fix', detail: 'one lane per confirmed bug, failing test first', model: 'opus' },
    {
      title: 'Merge',
      detail: 'serial merge-back, regenerate generated files, gate',
      model: 'opus',
    },
    {
      title: 'Reverify',
      detail: 'rebuild, reinstall, second fleet weighted to the fixes',
      model: 'sonnet',
    },
    {
      title: 'Teardown',
      detail: 'release and shut down only what this run claimed',
      model: 'sonnet',
    },
  ],
};

const REPO = '/Users/justin/Developer/futo-notes/futo-notes';

// ── Models ───────────────────────────────────────────────────────────────────
// EVERY agent() call below sets its model explicitly; nothing inherits. The
// facilitator running this script is usually Fable, which is the right tier for
// orchestration and the wrong one for both jobs here.
//   sonnet — the QA fleet and the mechanical steps: long device sessions, lots
//   of tool driving, where breadth per dollar is what you are buying.
//   opus — fix lanes, the serial merge, and triage. Triage is deliberately on
//   this side: it decides whether a fix lane gets spawned at all, and it is the
//   step that has to tell a real regression from a fixture artifact or a
//   pre-existing bug. A phantom P0 wastes an entire opus lane, so the cheap
//   place to spend is the gate.
const QA_MODEL = 'sonnet';
const FIX_MODEL = 'opus';

// ── Args ─────────────────────────────────────────────────────────────────────
// branch        (required) integration branch lanes fork from and merge into.
//               NEVER main: merging to main is the maintainer's call.
// lanes         fleet width (default 5). The iOS pool holds 7 devices TOTAL and
//               other checkouts hold some — Stations reports what it actually got.
// beats         override the beat list; each becomes one QA lane.
// platform      'ios' (default) or 'android'.
// skipReverify  stop after Merge (use when the fixes are TS-only and the embed
//               suite is the honest gate).
const BRANCH = args && args.branch;
if (!BRANCH || BRANCH === 'main') {
  return {
    aborted: `args.branch is required and must not be main (got: ${BRANCH}) — merging to main needs the maintainer`,
  };
}
const PLATFORM = (args && args.platform) || 'ios';
const LANES = (args && args.lanes) || 5;

// The beats are deliberately DISJOINT. Five agents told to "break the editor"
// all reach for the same emoji and the same 50k-line note; five agents given a
// beat each cover five times the surface.
const DEFAULT_BEATS = [
  {
    key: 'scale',
    brief:
      'Scale and volume: note sizes and shapes (one enormous paragraph, no blank line anywhere, huge tables/lists/fences, giant single words), open times, typing while large, scroll to the ends, many notes in one vault. Report honest timings, not verdicts about "fast".',
  },
  {
    key: 'text',
    brief:
      'Text, Unicode, IME and caret: emoji/ZWJ/skin tones, combining marks, RTL and bidi, CJK, astral-plane characters, autocorrect and predictive text, caret placement by tap at measured positions, typing over selections, undo after an autocorrection.',
  },
  {
    key: 'markdown',
    brief:
      'Markdown constructs and round-trip fidelity: seed a construct, open, edit ELSEWHERE, save, diff against the seed. Tables, fences, lists, quotes, headings, front matter, footnotes, hard breaks, reference links, autolinks, emphasis edges, escapes, entities, HR spellings, raw HTML.',
  },
  {
    key: 'gestures',
    brief:
      'Gestures: the block drag (lift, indicator, auto-scroll at both edges, drops at extremes, cancels), taps and double-taps before and after every gesture, multi-touch, keyboard up vs down, rotation, backgrounding mid-gesture.',
  },
  {
    key: 'lifecycle',
    brief:
      'Lifecycle, autosave and data integrity: background/terminate/navigate at every point relative to the save debounce, rename and delete while open, external changes on disk under an open note, undo storms, conflict copies, folder moves, launch with a partial file.',
  },
];
const BEATS = ((args && args.beats) || DEFAULT_BEATS).slice(0, LANES);

// ── The rules the last wave paid for ─────────────────────────────────────────
// Every line here is a mistake someone actually made. Keep them in the prompts.
const SAFETY = `HARD RULES (this repo):
- Touch ONLY the device assigned to your lane. Never another lane's device, and never a pool device claimed by a different checkout. Device claims are keyed to a WORKTREE path, which is why every lane gets its own worktree.
- Never the release app (com.futo.notes) and never the maintainer's real vault (~/Documents/futo-notes). The debug app (com.futo.notes.dev) uses its own fake-notes vault.
- No OS-level input to the Mac (no AppleScript UI scripting, no cliclick): it goes to the FOCUSED window and has hit the maintainer's live vault before (AGENTS.md M24).
- Never pattern-kill (no pkill -f): it reaches every checkout on the machine (M25). Terminate by UDID + bundle id, or by a PID you started.
- NEVER 'git stash' in a worktree. Stash is the REPO's single refs/stash, so a parallel lane's pop restores and drops YOUR work — it happened, and the victim's WIP was only recovered via git fsck. To test against a base commit use a throwaway worktree (git worktree add --detach) or 'git diff > /tmp/x.patch'. To park work, commit on your own branch and amend.
- The session scratchpad is SHARED. Put temp files under a subdirectory named for your lane, never at the scratchpad root.`;

const METHOD = `METHOD (each of these invalidated a real report):
- The VAULT FILE is the oracle. A screenshot proves rendering, never content. Read bytes (cat/xxd/od) after every scenario.
- NEVER build fixtures out of nonsense tokens. Autocorrect is ON in this app, so a block whose text is 'BBBBBBBB2222' or 'ABCDEFGHIJ' is ONE token to the keyboard: type next to it and the IME replaces the whole thing. That reads exactly like "the editor destroyed my block" and is not a bug — it produced TWO false P0s in one wave, one of them the orchestrator's. Use real words and ordinary sentences; when you need an exact marker, put digits/hyphens INSIDE a sentence of real words.
- MEASURE geometry, never guess it. Tapping at a y you assumed cost a wave an hour and a wrong verdict. Screenshot, find the line, then tap.
- A screenshot can FORCE A REPAINT and hide the very artifact you are hunting. For anything transient (blank regions, flicker, paint holes) capture with 'xcrun simctl io <udid> recordVideo' and extract frames.
- 'axe swipe' and 'axe drag' CANNOT express hold-then-drag: both apply --pre-delay BEFORE touch-down, so the app sees a scroll. Send separate 'axe touch -x X -y Y --down' calls at successive positions, then --up. See .claude/skills/verify/references/ios.md.
- Re-spelling is NOT loss. This editor re-serializes the whole note on any edit by design (ADR-0002 normalize-once): tilde fences become backticks, [X] becomes [x], '*' bullets become '-', delimiters get repadded, a trailing newline appears. Report content that is LOST or whose data VALUE changed. Say which of the two you have.
- Reproduce before reporting. Two independent runs, or say it is a single observation.
- NOT REACHED is a first-class result. Never let an untested scenario read as a pass.`;

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    beat: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string' },
          repro: { type: 'string' },
          expected: { type: 'string' },
          actual: { type: 'string' },
          diskEvidence: { type: 'string' },
          reproCount: { type: 'number' },
          fixtureUsedRealWords: { type: 'boolean' },
        },
        required: ['title', 'severity', 'repro', 'expected', 'actual'],
      },
    },
    heldUp: { type: 'string' },
    notReached: { type: 'string' },
  },
  required: ['beat', 'findings', 'heldUp', 'notReached'],
};

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          verdict: { type: 'string' }, // CONFIRMED | ARTIFACT | PRE-EXISTING | NEEDS-HARDWARE | UNRESOLVED
          severity: { type: 'string' },
          mechanism: { type: 'string' },
          evidence: { type: 'string' },
          introducedBy: { type: 'string' },
        },
        required: ['title', 'verdict', 'severity', 'evidence'],
      },
    },
  },
  required: ['verdicts'],
};

const LANE_SCHEMA = {
  type: 'object',
  properties: {
    done: { type: 'boolean' },
    branch: { type: 'string' },
    worktree: { type: 'string' },
    rootCause: { type: 'string' },
    summary: { type: 'string' },
    verification: { type: 'string' },
    negativeResults: { type: 'string' },
    residualRisks: { type: 'string' },
  },
  required: ['done', 'summary', 'verification'],
};

// ── Stations ─────────────────────────────────────────────────────────────────
phase('Stations');
const stations = await agent(
  `Set up ${BEATS.length} isolated QA stations for ${PLATFORM} against branch ${BRANCH}, in ${REPO}.

1. One git worktree per lane under .claude/worktrees/qa-<beat> at the tip of ${BRANCH} (detached is fine; these lanes never commit). Beats: ${JSON.stringify(BEATS.map((b) => b.key))}.
2. In EACH worktree run 'just qa-claim ${PLATFORM}' — claims are per-worktree, which is the whole reason for the worktrees. The pool holds 7 devices and other checkouts may hold some: if you cannot claim one for a lane, say so rather than sharing a device. 'just qa-status' shows who owns what. Never release a claim belonging to a worktree you did not create.
3. Build the app ONCE from ${REPO} (do not build per lane — it is the same commit): 'just build-ios-native' for ios, 'just build-android-native' for android. Then install that one artifact on every claimed device ('xcrun simctl install <udid> <path-to-.app>' / 'adb -s <serial> install -r <apk>').
4. Report the commit sha you built, and per lane: beat, worktree path, device udid/serial, install ok.

${SAFETY}
Return JSON: { sha, stations: [{beat, worktree, device, installed}], unavailable: [{beat, reason}] }.`,
  {
    label: 'stations:setup',
    model: QA_MODEL,
    schema: {
      type: 'object',
      properties: {
        sha: { type: 'string' },
        stations: { type: 'array' },
        unavailable: { type: 'array' },
      },
      required: ['sha', 'stations'],
    },
  },
);

const READY = (stations && stations.stations ? stations.stations : []).filter((s) => s.device);
if (READY.length === 0) {
  return { aborted: 'no stations got a device', stations };
}
if (stations.unavailable && stations.unavailable.length) {
  log(
    `${READY.length}/${BEATS.length} lanes have a device; no device for: ${stations.unavailable.map((u) => u.beat).join(', ')}`,
  );
}

// ── Hunt, then triage each lane's findings as soon as that lane reports ───────
// pipeline, not parallel: a fast beat's findings get verified while a slow beat
// is still hunting. The barrier comes later, where it is actually needed.
const beatOf = (key) => BEATS.filter((b) => b.key === key)[0] || { key, brief: key };

const triaged = await pipeline(
  READY,
  (station) =>
    agent(
      `You are the ${station.beat} lane of an adversarial QA fleet on the FUTO Notes ${PLATFORM} app. Your job is to BREAK it. Find bugs; do not fix them.

STATION (yours alone): worktree ${station.worktree} (cd in first), device ${station.device}, app com.futo.notes.dev built from ${stations.sha}. Do NOT rebuild. Vault (your oracle): the debug app's Documents/fake-notes inside that device's container.
${PLATFORM === 'ios' ? 'export AXE_BIN=/tmp/axe/axe and export SIM=' + station.device + ' in every shell block. Read the screen with node scripts/describe-ios-ui.mjs --udid $SIM, never a raw axe describe-ui dump.' : 'export ANDROID_SERIAL=' + station.device + '. Drive with node scripts/android-drive.mjs.'}
Read .claude/skills/verify/references/${PLATFORM}.md before driving anything.

YOUR BEAT: ${beatOf(station.beat).brief}

${METHOD}

${SAFETY}

Time-box to ~35 minutes of active testing, then report. Rank findings by severity (data loss > crash > wrong content > UI glitch). For each: exact numbered repro, expected vs actual, the disk bytes, how many times you reproduced it, and whether your fixture used real words. Then what held up, and what you did NOT reach.`,
      { label: `hunt:${station.beat}`, phase: 'Hunt', model: QA_MODEL, schema: FINDINGS_SCHEMA },
    ),
  (report, station) => {
    const found = report && report.findings ? report.findings : [];
    if (found.length === 0) return { beat: station.beat, verdicts: [] };
    // The step that matters. Half of a wave's "P0"s are the harness, the
    // fixture, or a bug that predates the branch — and a fix lane pointed at a
    // phantom is worse than no lane at all.
    return agent(
      `Independently triage findings claimed by the ${station.beat} QA lane on the FUTO Notes ${PLATFORM} app. You did not find these; your job is to establish which are real, on your own evidence. A refutation is as valuable as a confirmation.

Device ${station.device}, worktree ${station.worktree}, build ${stations.sha}. ${PLATFORM === 'ios' ? 'export SIM=' + station.device + ' AXE_BIN=/tmp/axe/axe' : 'export ANDROID_SERIAL=' + station.device}

CLAIMED FINDINGS:
${JSON.stringify(found, null, 2)}

For EACH finding, in this order:
1. Reproduce it yourself with a CORRECT fixture — real words, measured tap geometry, disk bytes as the oracle. If the reporter used a nonsense-token fixture, that alone can manufacture the symptom: re-run with real words before believing it.
2. If it reproduces and looks like a REGRESSION, find out whether it is one: build the branch point (git worktree add --detach /tmp/triage-base <base sha>, build, install on your own device) and run the same probe. A bug that reproduces on the base is PRE-EXISTING — say so, with both results. This is the single most useful thing you can do; a wave once bisected three builds chasing a "regression" that was an artifact, and separately shipped a fix for a bug that predated the branch.
3. Name the MECHANISM, not just the symptom. "Tapping blanks the body" is a symptom; "the caret's own block is re-created mid-typing because a plugin restamps an attribute" is a mechanism a fixer can act on.
4. Verdict: CONFIRMED (real, on this build, mechanism named) | ARTIFACT (harness/fixture) | PRE-EXISTING (reproduces on the base) | NEEDS-HARDWARE (only decidable on a physical device) | UNRESOLVED (say what you tried and what would settle it).

${METHOD}

${SAFETY}
Return one verdict per claimed finding, in the same order.`,
      {
        label: `triage:${station.beat}`,
        phase: 'Triage',
        model: FIX_MODEL,
        schema: TRIAGE_SCHEMA,
        effort: 'high',
      },
    ).then((t) => ({ beat: station.beat, verdicts: (t && t.verdicts) || [] }));
  },
);

// Barrier earned: two beats routinely find the same bug from different angles,
// so dedup needs every lane's verdicts at once before any fix lane is spawned.
const allVerdicts = triaged
  .filter(Boolean)
  .flatMap((t) => t.verdicts.map((v) => ({ ...v, beat: t.beat })));
const confirmed = [];
const seen = new Set();
for (const v of allVerdicts) {
  if (v.verdict !== 'CONFIRMED') continue;
  const key = String(v.title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 60);
  if (seen.has(key)) continue;
  seen.add(key);
  confirmed.push(v);
}
const rejected = allVerdicts.filter((v) => v.verdict !== 'CONFIRMED');
log(
  `${confirmed.length} confirmed after triage; ${rejected.length} not fixable as reported (${rejected.map((r) => r.verdict).join(', ') || 'none'})`,
);

if (confirmed.length === 0) {
  return {
    sha: stations.sha,
    confirmed: [],
    rejected,
    hunts: triaged.filter(Boolean),
    note: 'nothing survived triage — no fix lanes spawned',
  };
}

// ── Handover ────────────────────────────────────────────────────────────────
// Triage is done with the devices and the fix lanes need them: the pool is 7
// deep and other checkouts hold some, so a fix lane that cannot claim one
// verifies in a browser harness instead — strictly worse. One agent does this,
// not five in parallel, because releasing claims is a race.
phase('Handover');
const handover = await agent(
  `Release the QA fleet's device claims so the fix lanes can hold devices, in ${REPO}.
Release ONLY the claims held by these worktrees: ${JSON.stringify(READY.map((s2) => s2.worktree))} — run 'just qa-release' from inside each. Do NOT pass --shutdown (the same devices get re-used shortly) and do NOT touch a claim belonging to any other checkout; 'just qa-status' shows who owns what.
Leave the worktrees and their vault fixtures in place: the QA reports cite screenshots and vault snapshots inside them.
${SAFETY}
Return JSON: { released: [worktree], stillHeldByOthers: [{device, owner}] }.`,
  {
    label: 'handover:release',
    model: QA_MODEL,
    phase: 'Handover',
    schema: {
      type: 'object',
      properties: { released: { type: 'array' }, stillHeldByOthers: { type: 'array' } },
      required: ['released'],
    },
  },
);
log(`released ${((handover && handover.released) || []).length} fleet claims for the fix lanes`);

// ── Fix, one lane per confirmed bug ──────────────────────────────────────────
phase('Fix');
const fixes = await parallel(
  confirmed.map(
    (bug, index) => () =>
      agent(
        `Fix ONE confirmed bug in the FUTO Notes ${PLATFORM} app. Work in your own worktree and commit on your own branch; the orchestrator merges.

Worktree: create ${REPO}/.claude/worktrees/fix-${index + 1} on a new branch fix/<short-slug> at the tip of ${BRANCH}. Never touch ${REPO}'s working tree or any other lane's worktree.
Device: claim one in YOUR worktree ('just qa-claim ${PLATFORM}'). The QA fleet may still hold the pool — if nothing is free, verify against the built bundle in a browser harness (Playwright over build/native-editor/editor.html) and say clearly which claims rest on device evidence and which on the harness.

THE BUG (already reproduced and mechanism-named by an independent triage agent):
${JSON.stringify(bug, null, 2)}

Method (AGENTS.md 7.9 and the nearest nested manual own the details):
1. FAILING regression test first, at the narrowest layer that can hold it. Say what it printed before the fix.
2. Minimal fix in the narrowest real owner. Do not weaken a CRITICAL guard to make a test pass, and do not fix a symptom you cannot explain.
3. Run the owning chain and report the commands with their results. Then prove it on the device if you have one.
4. Update docs/spec/<area>.md when user-visible behavior changes, then 'just spec-gaps'. Never hand-edit generated files (GAPS.md, the generated native specs) — regenerate them.
5. Commit as type(scope): imperative summary, with a body naming the exact failure, the root cause, and a Verified: block listing commands run.

A MEASURED NEGATIVE IS A RESULT. If the honest answer is "this cannot be fixed at this layer", say so with the measurements that show it, revert your attempt, and record it as a spec Gap instead of shipping something inert. A wave shipped an attribute-based fix that the platform ignores; the value was the four measurements proving it, not the diff.
Report negativeResults explicitly, even when the fix worked.

${SAFETY}`,
        {
          label: `fix:${String(bug.title).slice(0, 28)}`,
          phase: 'Fix',
          model: FIX_MODEL,
          schema: LANE_SCHEMA,
        },
      ),
  ),
);

const ready = fixes.filter(Boolean).filter((f) => f.done && f.branch);
log(`${ready.length}/${confirmed.length} fix lanes ready to merge`);

// ── Merge ────────────────────────────────────────────────────────────────────
phase('Merge');
let merge = { merged: [], blocked: [], pushed: false, evidence: 'no ready lanes' };
if (ready.length > 0) {
  merge = await agent(
    `Serially merge finished fix branches into ${BRANCH} in ${REPO}. NEVER touch main. NEVER force-push.

Branches, in this order: ${JSON.stringify(ready.map((r) => ({ branch: r.branch, summary: String(r.summary).slice(0, 120) })))}

For EACH, one at a time:
1. git merge --no-ff <branch>.
2. Generated files conflict by construction because several lanes regenerate them — NEVER hand-resolve one. Take either side and regenerate: 'just spec-gaps' for docs/spec/GAPS.md, 'just bridge-spec' / 'just toolbar-spec' / 'just title-spec' for the native contracts. Then verify with the matching --check recipe.
3. A conflict in real source beyond the trivially-resolvable: git merge --abort, record it blocked with the file list, continue to the next branch.
4. After each merge: 'pnpm exec tsc --noEmit' plus the suites that lane's report named. Fix only obvious inter-lane interactions; otherwise reset that merge away and record blocked.
5. If a lane added a dependency, run 'pnpm install' in ${REPO} — a lane's node_modules is its own, so the main tree will not have it.

After the last merge: the deterministic gates ('just check' minus the timing-sensitive suites is fine if the machine is loaded — say which you ran), then plain 'git push'.
Do NOT run per-keystroke or per-frame budget tests while other agents are hammering devices; they measure the machine, not the code. Say if you skipped one for that reason.

${SAFETY}
Return JSON: { merged: [branches], blocked: [{branch, reason}], pushed: boolean, evidence: string }.`,
    {
      label: 'merge:serial',
      model: FIX_MODEL,
      phase: 'Merge',
      schema: {
        type: 'object',
        properties: {
          merged: { type: 'array' },
          blocked: { type: 'array' },
          pushed: { type: 'boolean' },
          evidence: { type: 'string' },
        },
        required: ['merged', 'blocked', 'pushed', 'evidence'],
      },
    },
  );
}

if (args && args.skipReverify) {
  return { sha: stations.sha, confirmed, rejected, fixes: fixes.filter(Boolean), merge };
}

// ── Reverify: rebuild, reinstall, hunt again with the fixes weighted ─────────
phase('Reverify');
const rebuilt = await agent(
  `Rebuild ${BRANCH} in ${REPO} after the merges and reinstall on the QA stations, then report the new sha.
1. Release nothing that belongs to another checkout. The QA lanes' worktrees are ${JSON.stringify(READY.map((s) => s.worktree))} — update each to the new tip (git checkout --detach <sha>) and re-claim its device if the claim lapsed.
2. Build ONCE from ${REPO} and install that one artifact on every station's device.
3. Report: { sha, stations: [{beat, device, installed}] }.
${SAFETY}`,
  {
    label: 'reverify:build',
    model: QA_MODEL,
    phase: 'Reverify',
    schema: {
      type: 'object',
      properties: { sha: { type: 'string' }, stations: { type: 'array' } },
      required: ['sha', 'stations'],
    },
  },
);

const fixedTitles = ready.map((r) => String(r.summary).slice(0, 140));
const second = await parallel(
  READY.map(
    (station) => () =>
      agent(
        `Second QA pass on the FUTO Notes ${PLATFORM} app, station ${station.beat}, now on build ${rebuilt && rebuilt.sha}. Fixes landed since your fleet's first pass:
${JSON.stringify(fixedTitles, null, 2)}

Split your time: FIRST prove or break those fixes on your beat (a fix that "held" without evidence is not a verdict — say what you did and what the disk said). THEN keep hunting new ground on your beat, especially anything the first pass left NOT REACHED.
A fix can be correct and still be wrong for the user: if a fix trades a bug for a worse experience (a refusal, a truncation, a notice that says the app cannot do something ordinary), say so plainly — that judgment is wanted, not out of scope.

STATION: worktree ${station.worktree}, device ${station.device}. ${PLATFORM === 'ios' ? 'export SIM=' + station.device + ' AXE_BIN=/tmp/axe/axe' : 'export ANDROID_SERIAL=' + station.device}

${METHOD}

${SAFETY}
Report per fix: HELD / BROKEN / PARTIAL / NOT REACHED with the evidence, then new findings ranked, then what held up.`,
        {
          label: `reverify:${station.beat}`,
          phase: 'Reverify',
          model: QA_MODEL,
          schema: FINDINGS_SCHEMA,
        },
      ),
  ),
);

// ── Teardown ────────────────────────────────────────────────────────────────
phase('Teardown');
const teardown = await agent(
  `Wrap up this wave's devices in ${REPO}, and nothing else.
1. Release AND shut down only the devices this run claimed: run 'just qa-release --shutdown' from inside each of ${JSON.stringify(READY.map((s2) => s2.worktree))} and from any fix worktree under .claude/worktrees/fix-* that this run created. 'just qa-status' must end with those devices unclaimed; devices owned by other checkouts must be untouched.
2. Kill only log-stream or recording processes YOU can identify by PID from this run. Never pattern-kill (M25).
3. LEAVE IN PLACE and report: the QA and fix worktrees (their screenshots, videos and ledgers are the evidence every finding cites), the merged fix branches, and the vault fixtures on each device. Deleting a worktree destroys the evidence a report points at — that is the maintainer's call, not this workflow's.
${SAFETY}
Return JSON: { shutDown: [device], leftInPlace: [path], untouched: [{device, owner}] }.`,
  {
    label: 'teardown:devices',
    model: QA_MODEL,
    phase: 'Teardown',
    schema: {
      type: 'object',
      properties: {
        shutDown: { type: 'array' },
        leftInPlace: { type: 'array' },
        untouched: { type: 'array' },
      },
      required: ['shutDown', 'leftInPlace'],
    },
  },
);

return {
  firstSha: stations.sha,
  secondSha: rebuilt && rebuilt.sha,
  confirmed: confirmed.map((c) => ({ title: c.title, severity: c.severity, beat: c.beat })),
  rejected: rejected.map((r) => ({ title: r.title, verdict: r.verdict, evidence: r.evidence })),
  fixes: fixes.filter(Boolean).map((f) => ({
    branch: f.branch,
    done: f.done,
    rootCause: f.rootCause,
    verification: f.verification,
    negativeResults: f.negativeResults,
    residualRisks: f.residualRisks,
  })),
  merge,
  secondPass: second.filter(Boolean),
  teardown,
};

export const meta = {
  name: 'ticket-wave',
  description:
    'One wave of agent-ready GitLab tickets: compute the grabbable frontier (blockers closed), run /implement per ticket in parallel (each in its own worktree off the target branch), light-review, serial merge-back, then close/comment the tickets - args {branch, maxLanes?, tickets?, match?, parentSpec?}',
  phases: [
    { title: 'Frontier', detail: 'which tickets are grabbable, sized to maxLanes' },
    { title: 'Implement', detail: 'the /implement skill, one agent per ticket, own worktree' },
    { title: 'Review', detail: 'light second pass - /implement already reviewed' },
    { title: 'Fix', detail: 'only confirmed critical/high findings' },
    { title: 'Merge', detail: 'serial merge-back + checks + push' },
    { title: 'Tracker', detail: 'close merged tickets, comment residuals' },
  ],
};

const REPO = '/home/justin/Developer/futo-notes';

// ── Args ─────────────────────────────────────────────────────────────────────
// branch      (required) integration branch lanes fork from and merge back into.
//             NEVER main: merging to main is the maintainer's call, always.
// maxLanes    wave width (default 3). Size to usage budget: 1 when tight.
// tickets     pin the exact ticket iids and skip frontier computation.
// match       substring that must appear in a ticket title (e.g. "Milkdown")
//             when computing the frontier from the ready-for-agent label.
// parentSpec  spec issue iid to post the wave summary on (optional).
const BRANCH = args && args.branch;
if (!BRANCH || BRANCH === 'main') {
  return {
    aborted: `args.branch is required and must not be main (got: ${BRANCH}) — merging to main needs the maintainer`,
  };
}
const MAX_LANES = (args && args.maxLanes) || 3;
const PINNED = (args && args.tickets) || null;
const MATCH = (args && args.match) || null;
const PARENT = (args && args.parentSpec) || null;

const RULES = `HARD RULES (this repo):
- Never touch ${REPO}'s working tree, main, or branches you don't own. Never merge anything yourself.
- Never publish anything external (upstream issues stay drafts; no store/registry actions). The internal GitLab tracker (glab) is allowed.
- Never pattern-kill processes (AGENTS.md M25). Claim devices only via just qa-claim inside your own worktree.
- Push your ticket branch when done; never force-push anything you didn't create this run.`;

phase('Frontier');
const frontier = await agent(
  `Compute the grabbable frontier of agent-ready GitLab tickets (run glab from inside ${REPO}).
${
  PINNED
    ? `PINNED MODE: the human already chose tickets ${JSON.stringify(PINNED)} — fetch each (glab issue view N), verify it is open and every blocker named in its "Blocked by" section is closed, warn about any that isn't, and return exactly the valid ones in the given order.`
    : `1. List open issues labeled ready-for-agent (glab issue list --label ready-for-agent)${MATCH ? ` whose title contains "${MATCH}"` : ''}.
2. For each, read its "Blocked by" section (glab issue view N). Grabbable = open AND every blocker closed.
3. Exclude tickets whose acceptance criteria require the maintainer personally (an explicit maintainer go, dogfood sign-off, or merge authorization) — those are human-gated.
4. Flag, but still include, tickets that need physical hardware (check adb devices / xcrun simctl as relevant and note availability).
5. Order critical-path-first: a ticket that transitively blocks the most open tickets outranks a leaf; break ties by ticket number.`
}
Return JSON: { lanes: [{ticket, title, url, hardwareNote}], skipped: [{ticket, reason}] } with lanes truncated to at most ${MAX_LANES}.`,
  {
    label: 'frontier',
    schema: {
      type: 'object',
      properties: { lanes: { type: 'array' }, skipped: { type: 'array' } },
      required: ['lanes', 'skipped'],
    },
  },
);
if (!frontier || !frontier.lanes || frontier.lanes.length === 0) {
  return { done: 'nothing grabbable', frontier };
}
log(
  `Frontier: ${frontier.lanes.map((l) => '#' + l.ticket).join(', ')} (skipped: ${frontier.skipped.map((s) => '#' + s.ticket).join(', ') || 'none'})`,
);

const LANE_RESULT = {
  type: 'object',
  properties: {
    ticket: { type: 'number' },
    branch: { type: 'string' },
    worktree: { type: 'string' },
    done: { type: 'boolean' },
    summary: { type: 'string' },
    verification: { type: 'string', description: 'exact commands run and their results' },
    residualRisks: { type: 'string' },
  },
  required: ['ticket', 'branch', 'done', 'summary', 'verification', 'residualRisks'],
};

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          confirmed: { type: 'boolean' },
          detail: { type: 'string' },
        },
        required: ['title', 'severity', 'confirmed', 'detail'],
      },
    },
    verdict: { type: 'string', enum: ['SHIP', 'FIX_FIRST'] },
  },
  required: ['findings', 'verdict'],
};

const laneResults = await pipeline(
  frontier.lanes,
  (lane) =>
    agent(
      `Implement GitLab ticket #${lane.ticket} (${lane.title}) by invoking the "implement" skill via the Skill tool — do not reimplement its process by hand. Invoke it with args:
"${lane.url || `https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/${lane.ticket}`} — make a worktree based off ${BRANCH} to avoid interference with other agents: git -C ${REPO} worktree add /home/justin/Developer/futo-notes-t${lane.ticket} -b wave/t${lane.ticket} origin/${BRANCH} (reuse it if it already exists and is clean). Work ONLY in that worktree. Push the branch when done. Do not merge or close the ticket."
Then follow the skill wherever it leads — it drives TDD and its own code review.
${lane.hardwareNote ? `HARDWARE NOTE: ${lane.hardwareNote} — if the required device is not actually available, make at most two genuine attempts to proceed, then stop and report honestly with a findings comment on the ticket instead of thrashing.` : ''}
${RULES}
Fill the structured output honestly — done:false with a good summary beats an inflated claim.`,
      { label: `implement:#${lane.ticket}`, phase: 'Implement', schema: LANE_RESULT },
    ),
  (impl, lane) => {
    if (!impl) return null;
    return agent(
      `LIGHT second-pass review of GitLab ticket #${lane.ticket} on branch ${impl.branch || `wave/t${lane.ticket}`} (worktree ${impl.worktree || `/home/justin/Developer/futo-notes-t${lane.ticket}`}). The /implement skill already ran a full code review, so do NOT repeat it. Your scope is narrow:
1. Diff sanity: git diff origin/${BRANCH}...HEAD — look ONLY for this repo's catastrophic classes: data-loss paths, CRITICAL guard weakening (dev/prod data, save/echo locks, push-first sync), private corpus or vault content accidentally committed, and M-rule violations (M5 typing hot path, M6/M7 single-source, M17 fixed-1-of-N).
2. Verify ONE claim: rerun the single headline verification command from the implementer's report and confirm it passes.
3. Nothing else — no style notes, no nice-to-haves.
Mark findings confirmed=true only when reproduced. Verdict SHIP unless a confirmed critical/high finding exists. Do not edit files.`,
      { label: `review:#${lane.ticket}`, phase: 'Review', schema: FINDINGS },
    ).then((rev) => ({ impl, rev }));
  },
  (prev, lane) => {
    if (!prev) return null;
    const { impl, rev } = prev;
    const confirmed = (rev?.findings || []).filter(
      (f) => f.confirmed && (f.severity === 'critical' || f.severity === 'high'),
    );
    if (!rev || rev.verdict === 'SHIP' || confirmed.length === 0) {
      return {
        lane: lane.ticket,
        branch: impl.branch || `wave/t${lane.ticket}`,
        impl,
        rev,
        fixed: null,
        ready: !!impl.done,
      };
    }
    return agent(
      `Fix these confirmed review findings on branch ${impl.branch || `wave/t${lane.ticket}`} in worktree ${impl.worktree || `/home/justin/Developer/futo-notes-t${lane.ticket}`} (ticket #${lane.ticket}):
${JSON.stringify(confirmed, null, 2)}
Failing regression test first where the layer supports it, minimal fix, rerun the owning chain, commit per convention (type(scope): summary + Verified: line), push.
${RULES}`,
      { label: `fix:#${lane.ticket}`, phase: 'Fix', schema: LANE_RESULT },
    ).then((fixed) => ({
      lane: lane.ticket,
      branch: impl.branch || `wave/t${lane.ticket}`,
      impl,
      rev,
      fixed,
      ready: !!(fixed && fixed.done),
    }));
  },
);

const lanes = laneResults.filter(Boolean);
const mergeable = lanes.filter((l) => l.ready);
log(
  `${mergeable.length}/${lanes.length} lanes ready to merge: ${mergeable.map((l) => '#' + l.lane).join(', ') || 'none'}`,
);

phase('Merge');
let merge = {
  merged: [],
  blocked: lanes.map((l) => ({
    ticket: l.lane,
    reason: l.ready ? 'not attempted' : 'lane not ready',
  })),
  pushed: false,
  evidence: 'no mergeable lanes',
};
if (mergeable.length > 0) {
  merge = await agent(
    `Serially merge finished ticket branches into ${BRANCH}. NEVER touch main.
1. Use (or create) the merge worktree: git -C ${REPO} worktree add /home/justin/Developer/futo-notes-wave-merge ${BRANCH} 2>/dev/null || true; in it git fetch origin && git checkout ${BRANCH} && git pull --rebase; pnpm install if node_modules missing.
2. Merge these branches one at a time, in the frontier's order: ${JSON.stringify(mergeable.map((l) => ({ ticket: l.lane, branch: 'origin/' + l.branch })))}. Use git merge --no-ff. A conflict beyond trivially-resolvable => git merge --abort, record blocked, continue.
3. After EACH successful merge: pnpm exec tsc --noEmit, targeted lint on changed files, and the suites that lane's report named. On failure: fix only if small and obviously an inter-lane interaction; otherwise reset that merge away and record blocked.
4. Push ${BRANCH} (plain push, never force).
Return JSON: { merged: [tickets], blocked: [{ticket, reason}], pushed: boolean, evidence: string }.`,
    {
      label: 'merge:serial',
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

phase('Tracker');
const tracker = await agent(
  `Update the GitLab tickets for this wave (run glab from inside ${REPO}). Lane outcomes: ${JSON.stringify(lanes.map((l) => ({ ticket: l.lane, ready: l.ready, summary: (l.fixed?.summary || l.impl?.summary || '').slice(0, 400), verification: (l.fixed?.verification || l.impl?.verification || '').slice(0, 400), residualRisks: (l.fixed?.residualRisks || l.impl?.residualRisks || '').slice(0, 300) })))}. Merge outcome: ${JSON.stringify(merge)}.
For each ticket:
- MERGED into ${BRANCH}: post a completion note (evidence: key commits, verification commands+results, residual risks) then close it (glab issue note N --message ..., then glab issue close N — close accepts no comment, so note first).
- Implemented but merge-blocked: post a note explaining the block and where the branch lives; leave open.
- Not done: post the honest status/findings note; leave open.
${PARENT ? `Also post ONE wave-summary note on the parent spec #${PARENT}.` : ''} Do not touch any other issue.
Return JSON: { closed: [tickets], commented: [tickets] }.`,
  {
    label: 'tracker:update',
    schema: {
      type: 'object',
      properties: { closed: { type: 'array' }, commented: { type: 'array' } },
      required: ['closed', 'commented'],
    },
  },
);

return {
  lanes: lanes.map((l) => ({
    ticket: l.lane,
    ready: l.ready,
    reviewVerdict: l.rev?.verdict,
    confirmedFindings: (l.rev?.findings || [])
      .filter((f) => f.confirmed)
      .map((f) => `${f.severity}: ${f.title}`),
    residualRisks: l.fixed?.residualRisks || l.impl?.residualRisks,
  })),
  merge,
  tracker,
};

---
name: verify-specs
description: Run the behavioral spec in docs/spec/ against the real apps — a parallel, story-driven QA sweep across desktop, iOS, and Android plus cross-client sync. Use when the user says "verify specs", "run the specs", "spec pass", "QA the specs", "check the app against the spec", or "/verify-specs [scope]". A bare run does the full spec (all surfaces × all platforms + sync mesh); a scope phrase ("since the last tagged release", "just the editor") narrows to the surfaces/platforms the diff touched. Fans out Sonnet low-effort app-qa legs, escalates FAILs to high effort, and is built to survive session-limit deaths without losing work.
---

# Verify Specs — parallel spec QA that resumes after a session death

This runs `docs/spec/` as **stories against the running apps** and reports
evidence-backed verdicts. It is not `just check` (that's the static chain);
this is the device-driven behavioral pass. Two modes, chosen from the invocation:

- **Full run** — `/verify-specs` (no scope) → every surface (`app`, `editor`,
  `list`, `nav`, `search`, `settings`, `settings-visual`, `sync`, `tabs`) ×
  every platform + the cross-client sync mesh.
- **Scoped run** — `/verify-specs since the last tagged release` (or "since
  <tag>", "just the editor", "what changed on this branch") → map the diff to
  spec surfaces + affected platforms and QA only those.

**Read `/mr-qa` and `/verify` first** — they are the source of truth for the
isolation model, the pooled-device topology, per-platform driving playbooks,
and the report format. This skill does **not** duplicate them; it adds three
things on top: (1) **scope from the spec, not from an MR diff**, (2) a
**Workflow-driven fan-out** that runs Sonnet at low effort and escalates only
FAILs to high effort, and (3) **session-limit survival** so a mid-run death
costs a resume, not a rerun. The subagent is `app-qa` (already Sonnet); the
low/high effort split is applied per-call by the workflow, which the Agent tool
cannot do.

## The pipeline at a glance

```
Step 1  Scope        full | diff-since-tag → {surfaces, platforms}
Step 2  Provision    worktrees · qa-claim · pre-build · qa-server   (INLINE — git/shell)
        └─ write test-screenshots/verify-specs/run.json (manifest + runId)  ← durable
Step 3  Fan out      Workflow(workflow.js, args=manifest)                    (parallel)
        per leg:   app-qa sonnet effort=low  ── sweep ──▶ FAIL? ── high ──▶ verify
Step 4  Aggregate    confirmed FAILs (upheld) · overturned · per-leg tables · ledgers
Step 5  Teardown     qa-release --shutdown · qa-server-stop --drop · remove worktrees
```

Everything in Step 2 must happen inline **before** the Workflow, because
workflow scripts have no git/shell/filesystem access. The Workflow only fans
out over fully-provisioned legs.

---

## Step 1 — Scope

```bash
cd "$(git rev-parse --show-toplevel)"
LAST_TAG=$(git describe --tags --abbrev=0)
echo "last tag: $LAST_TAG"
```

- **Full run** (no scope phrase): all 9 surfaces, all platforms this OS
  supports (`uname -s`: Darwin → desktop+iOS+Android; Linux → desktop+Android),
  plus the sync mesh.
- **Scoped run**: compute the diff (`git diff --name-only "$LAST_TAG"..HEAD`,
  or the branch base / user-named range) and map it to surfaces + platforms
  per **`references/scoping.md`** — read it.

Report the derived scope to the user before provisioning ("v1.6.0..HEAD
touched editor, sync, list, app across all platforms + iOS/Android shells —
QA those, skip nav/tabs/settings*").

## Step 2 — Provision (inline; this is the expensive part, done once)

Follow **`/mr-qa`'s `references/full-spec.md`** and **`/verify`'s "Isolation
model"** verbatim for the mechanics. The full-run topology (worktree/leg
table, surface groups, RAM caps, downshift rules) lives in
**`references/full-run.md`** — read it for a full run. Scoped runs usually
need only 1–2 worktrees; provision to the scope (`references/scoping.md`).

Provisioning order (eat every build wait HERE, before the fan-out — an agent
that idle-waits on a cold build gets force-collected):

1. `git worktree add` the extras off the scope's commit; `pnpm install` in all
   concurrently; `just qa-clone-target <worktree>` to seed a warm `target/`.
2. Per worktree: `just qa-claim` → record the printed `SIM` / `ANDROID_SERIAL`.
3. Pre-build every leg's app: `SIM=… just ios-native`, `just android-native`,
   desktop per `/verify` `references/desktop.md` (NOT `just tauri-dev`).
   Background them; within a worktree they serialize on the cargo lock (that's
   queueing, not a hang); across worktrees they're parallel.
4. `just qa-server` on the main worktree for the mesh (and for single-client
   sync stories — give that leg its own slot server or tell it exactly what
   already lives on the shared one).

**Per-platform concurrency equals how many devices you claim** — never hand
the workflow more device-backed legs of one platform than you booted devices
for; that's the one way to oversubscribe.

### Editor dedup — sweep the web editor once

The `editor` surface is the **same embedded single-file web editor** on all
three apps, so its rendering/decoration/interaction stories only need one full
sweep: give it to the **desktop** leg (cheapest to drive, MCP bridge, and on
macOS it's WKWebKit — the same engine as iOS). Mobile legs cover only what the
native shells actually own: set each iOS/Android editor leg's **`focus`** to
the shell-integration delta —

> futoBridge round-trips, toolbar actions, keyboard/IME (insets,
> scroll-during-IME), tap/selection/focus handoff, image insertion,
> safe areas — plus every editor story explicitly tagged *(iOS)* / *(Android)*.

This applies in both modes. It does NOT apply to `list`/`nav`/`search`/
`settings`/`tabs` — those are native SwiftUI/Compose implementations per
platform and must be swept on each platform they're in scope for.

### Write the durable run manifest (before launching the fan-out)

`mkdir -p test-screenshots/verify-specs`, then write
`test-screenshots/verify-specs/run.json` (gitignored, so it survives a session
death) — one entry per leg:

```jsonc
{
  "runNote": "full run @ HEAD (v1.6.0..HEAD scope: editor,sync,list,app)",
  "effort": { "sweep": "low", "verify": "high" },
  "legs": [
    {
      "id": "A-ios", "platform": "ios", "idPrefix": "ed",
      "worktree": "/abs/path/.claude/worktrees/extra-A",
      "surfaces": ["editor", "app"],
      "focus": "Shell-integration delta only: futoBridge, toolbar, keyboard/IME, …",
      "device": "iOS sim <udid>", "deviceEnv": "export SIM=<udid>",
      "ledger": "/abs/path/extra-A/test-screenshots/A-ios-ledger.md"
    },
    { "id": "mesh", "platform": "sync-mesh", "surfaces": ["sync"],
      "worktree": "/abs/main", "device": "desktop + iOS <udid> + Android <serial>",
      "deviceEnv": "export SIM=<udid> ANDROID_SERIAL=<serial>",
      "serverUrl": "http://127.0.0.1:31NN", "password": "testing123",
      "ledger": "/abs/main/test-screenshots/mesh-ledger.md" }
  ]
}
```

`focus` is optional; when present the leg covers exactly those flows and stops.
Ledger paths **must be absolute and inside each leg's own worktree** — that's
where the app-qa agent runs and where a resume looks.

A leg may also carry an optional `"focus"` string. With it, that leg covers
exactly the flows named and stops, instead of sweeping its whole surface and
reporting the remainder as SKIP noise:

```jsonc
{ "id": "A-ios", "platform": "ios", "surfaces": ["editor"],
  "focus": "only the toolbar-overflow and IME-scroll stories from the last run",
  "ledger": "/abs/path/extra-A/test-screenshots/A-ios-ledger.md" }
```

Omit it for a full sweep — that is the default and what a bare run uses. Reach
for it on a **resume** pass or a targeted re-check after a fix, where
re-sweeping the whole surface wastes a leg.

## Step 3 — Fan out via the workflow

```
Workflow({
  scriptPath: ".claude/skills/verify-specs/workflow.js",
  args: <the run.json contents, as a JSON value — not a string>,
})
```

The workflow (`workflow.js` next to this file) runs each leg as an `app-qa`
agent at **Sonnet effort=low** (the sweep); the moment a leg's sweep returns any
FAIL it spawns a **Sonnet effort=high** app-qa to independently refute those
FAILs — pipelined, so verification overlaps other legs' sweeps. The
`agentType`/`model`/`effort` are set per-call inside `workflow.js` because the
Agent tool has no per-call effort override.

**Capture the `runId`** the Workflow tool returns immediately, and append it to
`run.json`. It is your resume handle.

## Step 4 — Survive session limits (expect a death; minimize lost work)

Session limits *will* hit mid-run (8–9 concurrent QA agents burn ~2.5M
tokens/hour). Three layers make a death cheap:

1. **Ledgers (ground truth, survive anything).** Every leg appends each
   story's verdict to its ledger the instant it's decided — the brief tells it
   to, and to *resume from* an existing ledger without re-running done stories.
   Even a killed leg loses only the story it was mid-way through.
2. **Workflow resume (within-session).** On resume, re-invoke
   `Workflow({ scriptPath, args, resumeFromRunId: <runId from run.json> })`
   with **identical args**. Completed legs return from cache instantly; only
   in-flight/pending legs re-run — and those read their ledgers and skip done
   stories. If the journal is needed, read `<transcriptDir>/journal.jsonl`
   before assuming a cached leg was empty.
3. **Idempotent provisioning (across a restart).** On (re)entry, **check for
   `test-screenshots/verify-specs/run.json` FIRST.** If it exists with a
   `runId`, do NOT re-provision: `just qa-status` confirms the device claims
   still hold, worktrees persist on disk, and `qa-server` is likely still up.
   Verify, then jump straight to the resume in layer 2. Re-provisioning is what
   thrashes the device pool — don't.

If a leg comes back `needsResume` (its agent died before returning structured
output), its ledger still holds partial verdicts — resume just that leg.

**Scheduling tip:** launch a big wave right after a limit reset, and don't
provision more concurrent legs than the budget until the next reset will
sustain. A scoped run that fits one wave is far more likely to finish clean.

## Step 5 — Aggregate & report

The workflow returns `{ legs, confirmedFails, overturned, needsResume,
verdict }`. Present the `/verify`/`/mr-qa` report format:

- One verdict table per leg (story id → spec line → verdict → evidence path),
  reading the deep detail from each leg's ledger.
- **Confirmed FAILs** (sweep FAIL *upheld* by the high-effort pass) with
  expected (quote the spec) vs actual vs repro. These are the real findings.
- **Overturned** (sweep FAIL the verify pass disproved) — report as a
  false-alarm line, and if it recurs, it's a signal the low-effort sweep is too
  trigger-happy on that surface.
- Distinguish **BLOCKED** (environment can't exercise it — e.g. no Postgres →
  sync mesh blocked; Linux → iOS blocked) from **FAIL**.
- A confirmed new divergence → follow `/spec-sync` (record a `> **Gap:**` +
  closure probe, `just spec-gaps`). A regression against previously-verified
  behavior → recommend `/bugfix`, don't silently patch.

## Step 6 — Teardown

Per worktree: `just qa-release --shutdown` (also stops that worktree's sync
server), `just qa-server-stop --drop`, kill any launched desktop app, then
`git worktree remove` unless the user wants to iterate. `just qa-gc` reaps
strays. Delete `run.json` once the report is delivered and the user is done —
its presence is the "resume me" signal.

## Budgets (measured 2026-07, adjust with the effort experiment)

- Full spec, 3 platforms + mesh, prior high-effort topology: ~1.2–1.6M output
  tokens, ~3.5–4h wall clock. **This skill's bet:** Sonnet-low sweeps + editor
  dedup + the assertion-first evidence policy cut per-leg time and tokens
  materially, targeting **≤1h** on a strong machine with a warm pool. Report
  actuals so the bet can be judged.
- Scoped runs (the common case): a few 100k tokens, well under an hour.
- Failures cost more than passes (the high-effort verify pass). A run with many
  FAILs will run longer and hotter than a clean one.

---
name: verify-specs
description: Run the behavioral spec in docs/spec/ against the real apps — a parallel, story-driven QA sweep across desktop, iOS, and Android plus cross-client sync. Use when the user says "verify specs", "run the specs", "spec pass", "QA the specs", "check the app against the spec", or "/verify-specs [scope]". A bare run does the full spec (all surfaces × all platforms + sync mesh); "since the last tagged release" (or any scope phrase) narrows to the surfaces/platforms the diff touched. Fans out Sonnet low-effort app-qa legs, escalates FAILs to high effort, and is built to survive session-limit deaths without losing work.
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
- **Scoped run**: compute the diff and map it to surfaces + platforms. The
  mapping method (spec `→ path` authority refs + a fallback table) and the
  platform-derivation rules live in **`references/scoping.md`** — read it.

  ```bash
  git diff --name-only "$LAST_TAG"..HEAD   # or the branch base / user-named range
  ```

  Report the derived scope to the user before provisioning ("v1.6.0..HEAD
  touched editor, sync, list, app across all platforms + iOS/Android shells —
  QA those, skip nav/tabs/settings*").

## Step 2 — Provision (inline; this is the expensive part, done once)

Follow **`/mr-qa`'s "Full spec pass — parallel legs"** and **`/verify`'s
"Isolation model"** verbatim for the mechanics. The topology this skill targets:

**Default full-run topology — 4 worktrees:**

| Worktree | Devices claimed | Legs (concurrent, distinct devices) |
|---|---|---|
| extra-A | iOS + Android + desktop | group-A on iOS, Android, desktop |
| extra-B | iOS + Android + desktop | group-B on iOS, Android, desktop |
| extra-C | iOS + Android + desktop | group-C on iOS, Android, desktop |
| main | iOS + Android + desktop + `qa-server` | sync mesh (all clients → one server) |

Surface groups (same as `/mr-qa`): **A** = `editor` + `app`; **B** = `list` +
`nav` + `tabs`; **C** = `search` + `settings` + `settings-visual` + `sync`
(single-client). That's 9 platform legs + 1 mesh = **10 legs**.

Provisioning order (eat every build wait HERE, before the fan-out — an agent
that idle-waits on a cold build gets force-collected; see `/mr-qa` step 2):

1. `git worktree add` the extras off the scope's commit; `pnpm install` in all
   concurrently; `just qa-clone-target <worktree>` to seed a warm `target/`.
2. Per worktree: `just qa-claim` → record the printed `SIM` / `ANDROID_SERIAL`.
3. Pre-build every leg's app: `SIM=… just ios-native`, `just android-native`,
   desktop per `/verify` `references/desktop.md` (NOT `just tauri-dev`).
   Background them; within a worktree they serialize on the cargo lock (that's
   queueing, not a hang); across worktrees they're parallel.
4. `just qa-server` on the main worktree for the mesh (and for group-C's
   single-client sync stories — give C its own slot server or tell C exactly
   what already lives on the shared one; see `/mr-qa` step 6).

**RAM caps are a PROVISIONING decision, not the workflow's job.** Per-platform
concurrency equals how many devices you claim: claim 3 Android emulators → only
3 legs ever drive Android at once, regardless of the workflow scheduler. On
≤32GB keep **Android ≤3 concurrent** (mr-qa's measured ceiling) and iOS ≤4.
Downshift when the machine is small:
- **Fewer worktrees**: 3 worktrees + mesh-as-a-second-wave (run the Workflow a
  second time with only the mesh leg after the platform legs free their
  devices) keeps Android at 3.
- **Scoped runs** usually need only 1–2 worktrees — provision to the scope.

Do NOT hand the workflow more device-backed legs of one platform than you
booted devices for — that's the one way to oversubscribe.

### Write the durable run manifest (before launching the fan-out)

```bash
mkdir -p test-screenshots/verify-specs
```

Write `test-screenshots/verify-specs/run.json` (gitignored, so it survives a
session death) with the leg manifest — one entry per leg:

```jsonc
{
  "runNote": "full run @ HEAD (v1.6.0..HEAD scope: editor,sync,list,app)",
  "effort": { "sweep": "low", "verify": "high" },
  "legs": [
    {
      "id": "A-ios", "platform": "ios", "idPrefix": "ed",
      "worktree": "/abs/path/.claude/worktrees/extra-A",
      "surfaces": ["editor", "app"],
      "device": "iOS sim <udid>", "deviceEnv": "export SIM=<udid>",
      "ledger": "/abs/path/extra-A/test-screenshots/A-ios-ledger.md"
    },
    { "id": "mesh", "platform": "sync-mesh", "surfaces": ["sync"],
      "worktree": "/abs/main", "device": "desktop + iOS <udid> + Android <serial>",
      "deviceEnv": "export SIM=<udid> ANDROID_SERIAL=<serial>",
      "serverUrl": "http://127.0.0.1:31NN", "password": "testing123",
      "ledger": "/abs/main/test-screenshots/mesh-ledger.md" }
    // …one per leg…
  ]
}
```

Ledger paths **must be absolute and inside each leg's own worktree** — that's
where the app-qa agent runs and where a resume looks.

## Step 3 — Fan out via the workflow

```
Workflow({
  scriptPath: ".claude/skills/verify-specs/workflow.js",
  args: <the run.json contents, as a JSON value — not a string>,
})
```

The workflow (`workflow.js` next to this file) runs each leg as an `app-qa`
agent at **Sonnet effort=low** (the sweep), and the moment a leg's sweep
returns any FAIL it spawns a **Sonnet effort=high** app-qa to independently
refute those FAILs — pipelined, so verification overlaps other legs' sweeps.
The `agentType`/`model`/`effort` are set per-call there because the Agent tool
has no per-call effort override.

**Capture the `runId`** the Workflow tool returns immediately, and append it to
`run.json`. It is your resume handle.

## Step 4 — Survive session limits (expect a death; minimize lost work)

Session limits *will* hit mid-run (8–9 concurrent QA agents burn ~2.5M
tokens/hour — `/mr-qa` step 5). Three layers make a death cheap:

1. **Ledgers (ground truth, survive anything).** Every leg appends each
   story's verdict to its ledger the instant it's decided — the brief tells it
   to, and to *resume from* an existing ledger without re-running done stories.
   This is finer-grained than the workflow cache: even a killed leg loses only
   the story it was mid-way through.
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
  tokens, ~3.5–4h wall clock (`/mr-qa`). **This skill's bet:** Sonnet-low
  sweeps cut per-leg time and tokens materially, targeting **≤1h** on a strong
  machine with a warm pool — degrading gracefully (more waves) when
  device-starved. Report actuals so the low-effort bet can be judged.
- Scoped runs (the common case): a few 100k tokens, well under an hour.
- Failures cost more than passes (the high-effort verify pass). A run with many
  FAILs will run longer and hotter than a clean one.

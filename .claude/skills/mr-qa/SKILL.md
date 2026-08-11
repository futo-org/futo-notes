---
name: mr-qa
description: Parallel QA of one or more merge requests across desktop/iOS/Android, including cross-client sync. Use when the user wants MRs tested — "test MR !123", "QA these five MRs in parallel", "spin up QA for my open MRs", "test this branch on mobile" — or wants a full spec pass. Works the open MRs oldest-first and skips drafts. Creates a git worktree per MR for isolation, pre-builds, fans out one app-qa subagent per MR/platform leg concurrently, aggregates verdicts, and calls SHIP/NO SHIP on each — merging the SHIPs.
---

# MR QA — parallel by default

One MR = one worktree = one leg = one isolated stack (own pooled devices, own
sync server + database). QA several MRs **concurrently**; the `/verify` skill's
isolation model is what makes that safe.

## The parallelism floor

**One leg per non-draft MR, all launched concurrently.** This is a floor, not
a target: a pass over nine MRs that spawned two agents is a failed pass even
when every verdict it produced was right, because nothing fresh looked at the
other seven. The only permitted subtractions are drafts and MRs whose diff is
genuinely static-only (docs, CI config — no runtime code), which take the
static route below. An MR needing two platforms gets two legs.

**Prefer more, smaller subagents to one long-lived one**: give each `app-qa`
agent a single (MR × platform) leg, pinned to Sonnet. Its context then stays
about one diff on one device, which is what keeps its judgment about that diff
sharp — and a session-limit death costs one leg instead of the pass. Two MRs
in one agent eventually misattributes one MR's failure to the other (it has
happened here — see the `driver_session` default-app trap), and a
misattributed FAIL costs a re-run plus the credibility of the whole report.

The orchestrator routes, briefs, watches, adjudicates, and merges — it does not
run legs itself. Adjudicating an MR from your own reading of the diff is
exactly the shortcut this floor exists to close. Nor in the main checkout: that
strands whatever the user had in flight and re-invalidates the cargo/gradle
caches on every switch, so the "saved" setup comes back as cold builds. A
worktree is `git worktree add` plus `pnpm install`; a leg is one tool call.
Neither is worth economizing on.

## Reusing a prior pass's evidence

A previous pass's ledger is an **input to a leg, never a substitute for one**.
It makes a leg cheaper by telling the agent what is already settled; it does
not remove the leg.

- Reuse requires the MR head sha to be byte-identical to the sha that evidence
  was recorded against, **and** the verdict to be cited as carried over with
  its date: `PASS (carried over, 2026-08-07 pass, head sha unchanged)`. An
  uncited carry-over is indistinguishable from fresh evidence, which is what
  makes it dangerous.
- Reuse never covers a story the prior pass left **BLOCKED, flaky, void,
  retracted, or "lower confidence"**. Those are precisely the unresolved ones;
  they get fresh work or the MR is NO SHIP (insufficient coverage).
- **An unchanged branch is not an unchanged merge result.** Main moved
  underneath it, so the merged state is new even when the diff is byte-for-byte
  the same. A carried-over PASS is evidence about the branch as it was tested,
  not about what merging it does today — re-run anything that could interact
  with what has landed on main since.

## Pick the MR set — oldest first, drafts skipped

Work **oldest → newest** by iid. Old MRs have drifted furthest from main, are
likeliest to need a conflict resolved, and their author has waited longest;
landing them in that order also shrinks the diff every younger MR rebases over.

Skip drafts — GitLab exposes `"draft": true` and the `Draft:` title prefix, the
author explicitly saying "not ready". Name the skipped drafts in the report so
the user sees they were considered, not overlooked.

```bash
curl -s --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "https://gitlab.futo.org/api/v4/projects/futo-notes%2Ffuto-notes/merge_requests?state=opened&order_by=created_at&sort=asc&per_page=100" \
  | jq -r '.[] | select(.draft == false) | "\(.iid)\t\(.source_branch)\t\(.title)"'
```

Ordering governs the sequence you *start* legs in, not a serialization. If the
user names specific MRs, honor their list — still oldest-first, still flagging
any draft among them. **Re-query at the start of every pass**: the open set
drifts mid-session.

## Before anything

- **Probe host capability**: `xcrun` (iOS — absent on Linux, so iOS QA is
  impossible there), `adb devices` + `just qa-status` (Android pool), desktop
  (always available). Map each MR to the platforms its diff actually needs and
  state impossible coverage explicitly per MR — never silently drop it. From
  Linux, probe Justin's Mac over Tailscale (`ssh -o ConnectTimeout=5 …
  'xcrun -f xcodebuild'`) before writing iOS off; if it answers, work in a
  throwaway worktree there and say which iOS coverage was remote.
- **Route static-only MRs away from device QA.** A docs- or CI-only MR (e.g.
  `.gitlab-ci.yml`) is verified by (a) a green pipeline on its head sha AND the
  specific job it fixes having actually run (not skipped by rules), and (b) a
  static review against AGENTS.md §6C (M11–M16). No app-qa agents.

## Per MR (pipelines run concurrently across MRs)

1. **Static gate first, across all worktrees at once, before any device
   build**: `tsc --noEmit` + the MR's targeted unit tests. Dependency bump →
   duplicate-dependency check (`find node_modules/.pnpm -maxdepth 1 -name
   '@codemirror+view@*'` — M22's blank-editor failure). Editor/CM change →
   `pnpm run test:markdown-spec` is the key gate, but it runs in Chromium — the
   leg must still confirm decorations live in Tauri's WebKit.
2. **Worktree**: resolve the MR's source branch, then
   `git worktree add .claude/worktrees/mr-<iid> origin/<branch>` and
   `pnpm install` (installs run concurrently across worktrees).
3. **Claim + pre-build — before spawning any agent.** The orchestrator eats
   every build wait; agents idling on cold builds get force-collected:
   - `just qa-claim` (from the worktree) → note the `SIM` / `ANDROID_SERIAL`
     exports.
   - `SIM=<udid> just ios-native` and `just android-native`, backgrounded;
     within one worktree they partially serialize on the cargo `target/` lock
     (queueing, not a hang); across worktrees they're fully parallel.
   - MR touches shared code (`src/`, `packages/`, `crates/`) or desktop → also
     launch the desktop app per `/verify`'s `references/desktop.md` (NOT
     `just tauri-dev` — its auto-started server collides with `qa-server` on
     the same slot port).
   - `just qa-server` if the pass includes sync (it usually should).
4. **Spawn the legs** — one `app-qa` agent per (MR × platform). Brief each:
   worktree path, claimed device ids, server port/password, diff summary → spec
   surfaces, that apps are pre-built, the two hard driving rules, the three
   isolation traps, and any carried-over ledger with what it does and does not
   settle. Hand fixes to `fixer` (Opus-pinned) rather than asking a QA leg to
   fix what it found — a wrong fix is the most expensive thing this pipeline
   can emit.
5. **Monitor — idle ≠ progress.** `idle_notification {reason: available}`
   fires both while an agent parks on a long cold build AND when it has
   stalled/died. On each idle (or on a timer) verify actual progress: a live
   build process (`pgrep -af "worktrees/mr-<iid>" | grep -E
   'cargo|gradle|tauri|vite'`) plus ledger movement (`stat` + tail of
   `.qa-ledger.md`). Idle + neither = stalled → re-engage once via
   `SendMessage`; on a second stall (two strikes) take over the remaining
   checks yourself — the agent leaves its Tauri instances + qa-server running,
   so drive them directly or run `pnpm run test:cross-platform`.
6. **Aggregate**: one verdict table per MR (stories + sync legs, with evidence
   paths), FAIL details quoting the spec, and a cross-MR isolation note (any
   collision finding is a bug in the isolation layer — report it loudly).
7. **Verdict + merge** — see the next section. The pass is not done until this
   step is.
8. **Teardown per worktree**: `just qa-release --shutdown` (also stops that
   worktree's server), `just qa-server-stop --drop`, kill the desktop app if
   launched, then `git worktree remove` unless the user wants to iterate on
   that MR. `just qa-gc` reaps devices of deleted worktrees.

## SHIP / NO SHIP — and merging is part of the verdict

Every MR in the pass gets an explicit **SHIP** or **NO SHIP** line. A wall of
evidence with no verdict pushes the decision back onto the user, which is the
one thing this pass existed to take off their plate. If the evidence genuinely
doesn't support a call, that is itself a verdict — **NO SHIP (insufficient
coverage)** — naming the leg that was blocked rather than hedging.

**Merging a SHIP is part of reaching the verdict, not a step after it.** A
pass that ends with `SHIP` and an unmerged MR has not finished. Don't stop to
ask; merge, then report what landed.

```bash
curl -s --request PUT --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "https://gitlab.futo.org/api/v4/projects/futo-notes%2Ffuto-notes/merge_requests/<iid>/merge"
```

Merge the SHIPs **oldest-first, one at a time, re-checking the next MR's
mergeability after each merge.** That re-check is load-bearing, not ceremony:
landing one MR has already put a younger one into a content conflict the same
afternoon.

SHIP requires all of these. Any one missing makes it NO SHIP, not a judgment
call:

- No unexplained FAIL. A FAIL is either fixed on the branch, or shown to be
  pre-existing on main / a broken gate **with the evidence for that claim**
  (see the tally procedure below; "probably the isolation layer" is not
  evidence).
- Coverage actually matched the diff, from this pass or a legitimately
  carried-over one. An `apps/ios` MR whose iOS leg was impossible is NO SHIP
  (insufficient coverage), however clean the desktop leg looked.
- GitLab says it can merge: green pipeline **on the head sha**, no conflicts,
  no unresolved discussion threads, not a draft.
- `just check` passes in the MR's worktree if the diff touches shared code.

**The permitted holds are a closed list**: AGENTS.md §11's stop-and-ask items,
and nothing else — anything under `keys/` or the updater trust boundary, a
CRITICAL guard (dev/prod data split, push-first sync, the release gate, the
dep-guard, hash/crypto), publishing, or a cross-cutting protocol change (sync
payload, `BRIDGE_VERSION`, `AppState` schema). A clean QA pass says the code
behaves; it doesn't say the trust boundary or the wire format should move.
Report those as **SHIP (needs your merge)** with the reason, and leave them
open.

**Nothing else is a hold.** Not an unrelated open incident. Not an unfinished
sibling leg on another MR. Not wanting the user to confirm something else
first. Not general caution. Ask one question: does this bear on whether *this*
MR behaves correctly? If not, it does not gate *this* MR. This has already
been violated: an MR with nine passing stories and a green pipeline was held
because a *different* leg had leaked keystrokes into the user's real vault and
the orchestrator wanted the data question settled before merging anything.
Those were two threads, and only one of them was about the MR.

For a NO SHIP, say what would flip it — a fix, a rerun on a named platform, or
a decision only the user can make. Hand fixable ones to `fixer` if the user
asked for fixes; otherwise leave the finding on the MR as a comment so the
author has it.

## Attributing a red CI job

"Probably infra" is not evidence — and neither is "it went red on this MR, so
it's this MR". **Tally the failing scenario across every recent pipeline and
every branch**, then group by ref:

```bash
curl -s --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "https://gitlab.futo.org/api/v4/projects/futo-notes%2Ffuto-notes/pipelines?per_page=50" \
  | jq -r '.[] | "\(.ref)\t\(.status)\t\(.id)"'
```

Same assertion failing across unrelated branches = a broken gate. Failing only
here = the MR. The decisive case is a branch carrying **zero runtime code**: a
docs- or CI-only MR cannot break a runtime assertion, so that job failing
there proves the gate rather than the branch. One such failure can still be a
flake — it took two consecutive failures on the same docs-only MR to make it
conclusive. Write the tally into the report either way, so the next pass
doesn't redo it, and treat a broken gate as its own finding (report it; M15 —
never loosen it to get green).

## Two hard rules for driving apps under QA

Both were learned by damaging the user's real data. Brief every leg on both.

1. **Drive the desktop app only through the Tauri MCP bridge, with an explicit
   `appIdentifier`.** Never `osascript`/System Events keystrokes, never
   `cliclick`, never any other OS-level input — and never brief an agent to
   (a prior QA ledger did, which is how this happened). Every build shares the
   process name `futo-notes-tauri`, so a lookup by process name or unix id
   resolves to whatever instance the OS picked — it resolved to the installed
   production app, and a Cmd+Z landed in the user's live vault. OS-level input
   has no way to name which app it is talking to; the bridge does. Prefer
   in-page instrumentation (`webview_execute_js`, `window.__notesShellTest`,
   `window.__testSync` — `src/features/sync/testSync.ts`) to screen capture
   wherever the state is readable from the page. When a check genuinely needs
   real input plumbing (M21: DOM `click()` doesn't fire Svelte 5 handlers), use
   the bridge's `driver_session` or Playwright `page.keyboard` against the same
   code — not the OS. To turn a port or PID into something you may drive at all,
   use the one sanctioned resolver, `node scripts/qa-target.mjs list|pid|port`:
   it vets the executable's real path against this repo's worktree list plus the
   instance's data dir and vault, and exits 3 on anything else. *(This paragraph
   is the prohibition itself; `scripts/check-qa-input-safety.mjs` enforces it and
   pins these lines in `scripts/qa-input-safety-allowlist.json`.)*
2. **Never write into a shared vault.** A leg generates its test vault inside
   its own worktree, under that worktree's `FUTO_NOTES_DATA_DIR`. Never the
   user's real notes directory (M3), and never the machine-global dev
   `fake-notes` default either — two legs there scribble over each other and
   over whatever the user's own dev build is doing.

## Isolation traps (brief every agent up front — they recur)

1. **Slot-hash collision** — the canonical derivation in `scripts/lib/slot.mjs`
   can collide at ~5 concurrent worktrees (two worktrees → same slot: same
   Vite port + same `com.futo.notes.verify.s0` identifier, and
   `driver_session` silently reuses the *other* app). On any collision fall
   back to a unique identifier `com.futo.notes.verify.mr<iid>` + a manually
   picked free port. Related MCP trap: with >1 connected Tauri app the
   last-connected becomes the default, so unqualified
   `webview_execute_js`/`read_logs` calls land on another MR's app — always
   pass `appIdentifier: <port>` explicitly.
2. **`tests/cross-platform-sync.mjs` is NOT per-worktree isolated** — it shells
   to a machine-global Postgres container, so it deadlocks/401s under parallel
   load. Run it when contention is low, or mark it BLOCKED (pre-existing
   infra, not the MR) — and remember a BLOCKED story is never carried over.
3. **F-series `server_integration` needs `AUTH_MODE=dev`**, but
   `just qa-server` runs `AUTH_MODE=password` (correct for the mesh). Agents
   spin their own isolated dev-mode server for that suite.

## Evidence for every defect you report

**Film the comparison, never the failure alone**: one pane on the MR branch,
one on `main`, same script, same clean start. Not because prose is worse, but
because reducing the bug to a deterministic script is what catches
misdiagnosis — a pass called an undo failure a regression on the strength of
two hand-driven instances, and filming the control side by side showed both
branches behaved identically and the bug was pre-existing. Frame extraction
likewise proved a real blank-frame regression. Film through the sanctioned
drivers above: a clip obtained with OS-level input is not evidence, it is a
second incident. Mechanics — per-surface recorders, captioning, uploading to
the MR, and how to retract a finding — are in
[`references/evidence.md`](references/evidence.md).

## Scope and cost

Default to MR-scoped: map the diff to `docs/spec/<surface>.md` surfaces and QA
those, plus the cross-client sync smoke whenever the diff touches sync, the
shared Rust core, or the editor. A typical MR pass costs ~100–250k output
tokens (failures cost more than passes). Device pool: 7 per platform, 50 port
slots; the practical ceiling on simultaneous MRs is RAM/CPU during overlapping
cold builds — stagger the build step past ~3 fresh worktrees. Budget pressure
is a reason to make legs cheaper (narrower scope, a carried-over ledger as
input, Sonnet legs), never a reason to run fewer of them.

**Full spec pass** (only when asked — 5–10× the cost of an MR pass): use the
parallel-leg topology in [`references/full-spec.md`](references/full-spec.md),
never sequential legs.

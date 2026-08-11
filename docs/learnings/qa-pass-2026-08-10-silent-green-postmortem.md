# The 2026-08-10/11 QA pass: why it cost two days, and the seven patterns behind it

A two-day MR QA pass landed 13 MRs. Only four of them existed when the pass started; nine were
created in response to what it found. That ratio is the headline: the expensive part was not merging,
it was that the pass kept finding real defects, and a large share of them were **defects in the things
that were supposed to be catching defects**.

This is the postmortem for the *classes*, not the individual bugs. Each pattern below is followed by
the cheapest check that would have caught it.

## Pattern 1 — Tests that pass whether or not the behaviour works

The single largest cluster, and the reason a data-loss bug survived in `main` under a green suite.

| Evidence | What was wrong |
| --- | --- |
| Deleting `flushPendingSave` from the sync harness left the suite green (!212) | the assertion never observed the thing it named |
| `flush_draft_serializes_its_check_and_write_against_sync_mutations` (!202) | measured mutex queue depth, not the invariant — and poisoned a process-wide guard, cascading into 23 unrelated tests |
| The mesh harness rebuilt the desktop binary only when it was **missing** (fixed in !217) | a re-run reported byte-identical results at `bootstrap 19ms` while testing the *previous* binary |
| `killStalePreviewAndClients()` survived a merge as a call with no definition | `node --check` validates syntax, so it passed; the mesh died before scenario 1 with `Fatal: … is not defined` |
| A mesh scenario was silently duplicated by a merge, one copy calling `waitForSavePending` — a helper `main` had already replaced | git placed the copies at different offsets, so no conflict marker appeared |
| Two scenarios carried `skipOnCi: true`, covering the exact surface under change (#91) | CI was green because the relevant scenarios never ran |
| !205's pipeline reported success with `test:rust:workspace` **absent** and `test:cross-platform-sync` **manual** | `changes:` rules evaluated against a stacked MR's narrow diff |

**Prevention.** The repo already proves its *gates* can fail: `scripts/gate-redproofs.mjs` seeds one
violation per gate and rejects an exit-code-only pass. Extend that idea from gates to the handful of
**data-safety behavioural tests**: seed the bug, require red. And add a coverage attestation — for a
pipeline to count as green, assert that the jobs proving spec-critical behaviour actually *ran*, rather
than being skipped, manual, or absent. This is M11 generalised from "assert the outcome" to "assert the
assertion ran".

## Pattern 2 — Assertions that encode observed behaviour instead of required behaviour

Two tests written during this work asserted the bug **as an invariant**:

- !204's `no_reachable_fact_combination_can_discard_unsaved_work` asserted `rebased == disk` for
  *every* `KeepDraft` arm — exhaustively, over an alphabet. That is precisely the #89 clobber, promoted
  to a property.
- !148's `androidKeepsADraftTypedWhileAPeerEditIsDeferred` asserted the phone's draft ends up at the
  note's own id — i.e. that it overwrote the peer's bytes.

Both were written by observing what the code did and freezing it. Both had to be rewritten before the
fix could land, and the first one nearly convinced the reviewer (me) that the fix was wrong — see
Pattern 6.

**Prevention.** For data-safety behaviour, derive the assertion from `docs/spec/` prose and name the
spec line in the test. If no spec line exists, write it first. The repo's existing rule — a bug fix's
regression test fails before the fix and passes after — should extend to *feature* tests: a new
behavioural test must be shown failing against the pre-feature behaviour.

## Pattern 3 — Verification instruments trusted without a control

Every one of these returned a confident, wrong answer:

- A rAF + `getBoundingClientRect` probe reported **0 blank frames for both variants** — it samples
  main-thread offset while WebKit scrolls on its own thread.
- A vault check built on `find`'s `-newermt` predicate, handed a **relative** offset instead of an
  absolute timestamp, matched **nothing** on BSD/macOS — relative arguments there neither parse nor
  error. It reported "production vault untouched" while four files had in fact been written minutes
  before. (The safe form is `touch -t <absolute stamp>` on a reference file plus `-newer <ref>`; the
  banned form is enumerated in `scripts/check-qa-input-safety.mjs` as `relative-newermt`, which is
  why this paragraph describes it rather than quoting it — see below.)
- Two Playwright "control" runs issued as parallel shell calls, one with an explicit `cd` — both
  executed in the *same* worktree, the one that had the fix. "Passes on both sides" was an artifact,
  and it sent an agent hunting a Linux-only race that did not exist.
- `eslint --no-eslintrc --env node --rule no-undef` returned clean; its flags are dead under flat
  config, and a positive control with a deliberately undefined call **also** returned clean.
- `taskset` CPU pinning as a lock-contention amplifier reproduced nothing in 20 runs; the real
  amplifier was fsync latency.

**Prevention.** Before believing a *negative* result, prove the instrument can produce a positive one.
One line, every time: seed the condition you claim is absent and watch the tool fire. A tool that has
not been shown to fail is not evidence of absence. Silence is not success.

**Footnote, earned while writing this file.** The first version of the paragraph above quoted the
offending `find` command verbatim, and `scripts/check-qa-input-safety.mjs` failed the build on it:
that pattern is banned on instruction surfaces, and the gate cannot tell a cautionary quotation from a
recommendation. The gate's own error message says *"Do not allowlist a new occurrence to get green"* —
so the right response was to describe the hazard instead of reproducing it, not to add an allowlist
entry for a postmortem. Worth knowing before writing any doc that discusses a banned technique: a
prose description costs nothing, and widening the allowlist to land a document about rigour would
have been a poor trade. It is also a small vindication of the guard — it fired on its own author.

## Pattern 4 — One rule living in four places

The open-note decision existed in Rust (`classify_open_note`), desktop (two copies), iOS, and Android.
The consequence was not abstract: `KeepDraft{Diverged}` rebased the editor's baseline onto the pulled
disk content, which made the next `flush_draft` a fast-forward (`current == base`) instead of the park
its doc comment promised — so desktop **destroyed** a peer's edit with no conflict copy, while iOS and
Android happened to park correctly because their own copies passed the pre-pull base. Adopting the
shared verb would have *spread* the bug to the two shells that were accidentally right.

**Prevention.** This is what the disposition verb and `scripts/drift-registry.json` exist for. The
operational lesson is about ordering: **fix the canonical copy before adopting it anywhere.** The
intermediate state — verb landed, some shells still running their own copy — is exactly where the
divergence hid, and it is also the state in which a well-meaning adoption regresses a working shell.

## Pattern 5 — Stacked MRs amplify one defect into three misdiagnoses

`!203 → !204 → !205 → !148` were chained. !204/!205/!148 were based on a !203 head that predated its
own fix commit, so the same e2e failure appeared on three pipelines. It read as a regression in the
feature; it was a stale base. That cost one long, wrong investigation.

The stacking also multiplied real work: the same three files (`docs/spec/sync.md`, the **generated**
`docs/spec/GAPS.md`, `tests/cross-platform-sync.mjs`) had to be conflict-resolved once per link in the
chain, and each link needed its own pipeline round.

**Prevention.** Two things, both cheap:

1. A ~5-line check (papercut `pc_5a63b8c3bbff`): for every open MR whose `target_branch` is another
   open MR's `source_branch`, assert
   `git merge-base --is-ancestor origin/<target_branch> origin/<source_branch>`. Scope it to *stacked*
   MRs only — run against `main` it would fire on every MR merely behind main and drown the signal.
2. Do not stack a single-author, single-feature change across four MRs. There is no independent review
   value, and the cost is paid four times.

## Pattern 6 — A reviewer's confident objection, sourced from a test comment

The #89 fix was correctly diagnosed, then nearly redesigned into something worse. The objection was
that F2 required `KeepDraft`'s baseline to describe disk — sourced from the F2 citation in !204's
property test. Reading the spec settled it: F2 (`docs/spec/sync.md`) is about the reload gate firing on
`SyncSummary.localWritesApplied` so a stale editor's next **unconditional autosave** cannot clobber a
push-side clean merge. Its facts are `draft == base` — the Adopt arm, not `KeepDraft`. The test cited
F2 correctly for the *Converged* arm and its property then over-generalised to all arms.

The proposed alternative — carrying two baselines — would have introduced a **new** loss: with a
disk-based dirty baseline, a draft edited back to its base during a cycle fabricates dirtiness and
writes pre-pull text over the peer. That case is now pinned by
`crates/futo-notes-ffi/tests/open_note_flush.rs::a_draft_edited_back_to_its_base_during_a_cycle_never_fast_forwards_over_the_peer`.

**Prevention.** A test comment is not the spec. When an invariant is invoked to block a fix, read the
spec line and the code it points at before acting on it. And when an implementer pushes back on a
reviewer's design, that is signal, not friction — here the implementer was right twice.

## Pattern 7 — Shared mutable infrastructure, and the cost of the guard that fixed it

The sync harness shelled to a **machine-global** Postgres database with no slot namespacing, so
parallel worktrees destroyed each other's data; ports collided the same way. Fixed in !216 with
slot-derived ports and per-slot databases. Separately, reusing one remote directory for two concurrent
runs produced two bogus results — fixed with a worktree lock.

There is a live tradeoff worth naming. `scripts/remote-test.mjs` deliberately does **not** export
`CARGO_TARGET_DIR`, because `ci-cargo-cache-freshness.test.mjs` reads it and fails when it is set. That
guard is correct as far as it goes, but it forces a separate cargo target per remote directory: after
this pass, `~/ci` on the Linux runner held **13 directories totalling 62 GB**, with targets of
7.5–13 GB each, and every new verification directory paid a ~10-minute cold build.

**Prevention.** Make `ci-cargo-cache-freshness` insensitive to a legitimately-set `CARGO_TARGET_DIR`
(or scope it to CI), then let the remote runner share one target cache across directories. And add a
reaper for `~/ci/*` and the per-slot `futo_notes_xplat_s<slot>` databases, which nothing currently
cleans up.

## The one-line summary

Nine of thirteen MRs were work this pass created, and most of that work was repairing the verification
layer: a suite that stayed green while data was destroyed, harnesses that tested stale binaries, gates
whose relevant jobs never ran, and instruments that returned confident false negatives. The product
bugs were real, but they were *findable* — what made them expensive was that nothing red ever
appeared. Every prevention above is a variation on the same rule: **prove that the thing which would
have failed, fails.**

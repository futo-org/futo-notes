---
name: rewrite-from-contract
description: Rebuild tangled or AI-generated-looking code — one function up to an entire subsystem — from its observable behavioral contract while preserving external functionality and discarding accidental architecture. Optionally prunes the contract itself first (keep/simplify/drop triage of spec behaviors, human-gated) when the requester has said features may be dropped. Use when asked to identify the next "AI slop" area, deslop or radically simplify a codebase, rewrite a subsystem from scratch, start from tests, replace a giant orchestrator/controller/component, contract-rewrite something, "do this like the sync rewrite", preserve outside behavior without retaining internals, prune or triage a feature surface ("features I'd be OK dropping"), or turn legacy tests into a new implementation and MR. Not for bug fixes (/bugfix), small cleanups (/simplify), or changes that keep the existing structure.
---

# Rewrite From Contract

Replace accidental architecture without weakening product behavior. Treat
high-fidelity external tests as the executable contract and legacy internal
tests as evidence to translate, not private APIs to preserve.

Proven twice in this repo: `docs/learnings/sync-rewrite.md` (8,519-line Rust
orchestrator → 4-file crate, 171-test ledger) and
`docs/learnings/notes-shell-session-sync-rewrite.md` (desktop shell/session/sync
owners, 61-test ledger). Read the one closest to your scope's layer before
starting. Repo-specific suites, isolation, and constraints:
`references/futo-notes.md`.

## Non-negotiable rules

1. Work in a fresh worktree from current main. Never reuse a dirty checkout.
   (Function/module scope only: a new branch in an otherwise clean primary
   checkout is acceptable — verify `git status` is clean first.)
2. Establish the behavioral baseline before deleting production code.
3. Translate every removed internal test into a plain-English promise and an
   explicit disposition.
4. Preserve external behavior, safety invariants, and public interfaces—not
   private planners, adapters, mocks, class boundaries, or file layout.
5. Do not adopt an old, alternate, or experimental implementation wholesale.
   Use it as evidence only unless each part earns its place in the new model.
6. Fix failures as shared ownership rules. Do not add scenario-specific patches
   or platform-shell exceptions.
7. Rebase onto current main and rerun the complete external gate before
   publishing or declaring success.

## Choose the operating mode

- For “where should we tackle next?”: perform candidate discovery and return a
  ranked recommendation with a concrete rewrite boundary. Do not implement.
- For “rewrite/fix/do it”: continue through implementation, verification,
  documentation, commit, push, and MR when authorized.
- For “diagnose/review”: inspect and report evidence. Do not mutate production
  code unless requested.
- **Pruning mode** (Phase 4) is additionally active ONLY when the requester has
  explicitly said behavior may be dropped or simplified (“prune”, “there are
  features I'd be OK dropping”, “whittle down”). Without that authorization the
  contract is preserved exactly — never infer permission to drop a feature from
  the general goal of reducing code.

## Scale ceremony to scope

The process is identical at every scope; only the blast radius changes.

| Scope | Where to work | Contract gate | Ledger + learning doc |
|---|---|---|---|
| One function | clean branch, in-tree | its tests + every caller's tests | ledger inline in the report; no learning doc |
| Module / file | clean branch or worktree | the owning layer's suite | ledger inline in the report |
| Crate / subsystem | always a fresh worktree | full acceptance suites incl. real-service / E2E | ledger + learning doc committed to `docs/learnings/` |
| Whole codebase | never big-bang — decompose into subsystem-sized runs of this skill, sequenced by dependency, each landing as its own MR | per subsystem | per subsystem |

## Phase 1: isolate and baseline

1. Read repository and nested agent instructions completely.
2. Fetch current main.
3. Create a new branch and worktree from the fetched main.
4. Record the starting commit and confirm the new worktree is clean.
5. Locate external dependencies such as a real server, database, fixture
   corpus, simulator, browser harness, or comparison oracle.
6. Run the highest-fidelity existing suites before changing code. Record exact
   pass counts and commands.

Never use a user’s demo or production service for acceptance testing. Use an
isolated port, database, data directory, and cleanup procedure. (In this repo:
`just qa-server` + `FUTO_NOTES_DATA_DIR` — see `references/futo-notes.md`.)

## Phase 2: find the rewrite boundary

Run `scripts/audit_repo.sh [repo] [git-since]` for an initial read-only
inventory, then inspect leading candidates manually.

Score each candidate on:

- accidental complexity: giant owners, duplicated policy, callback graphs,
  global mutable state, catch-and-ignore paths, repeated adapters;
- churn: repeated corrective commits and the same bug class returning;
- ownership confusion: the same lifecycle or rule assembled in several shells;
- contract strength: integration, end-to-end, protocol, fixture, golden,
  conformance, or oracle coverage;
- payoff: deletable production code and fewer concepts/call sites;
- risk: data loss, unobserved behavior, or missing failure injection.

Prefer a high-complexity candidate with a strong external contract. A large
file without a strong contract is a test-creation project first, not a rewrite
project.

Define a sharp cut line:

- what observable API and effects remain;
- what production modules are replaceable;
- which consumers must compile unchanged;
- which neighboring systems stay out of scope;
- which external suites decide success.

For candidate reports, include evidence: source lines, churn, number/type of
tests, the suspicious ownership pattern, and why the runner-up is weaker.

## Phase 3: extract the behavioral contract

Inventory three sources separately:

1. External contract: real-service tests, E2E scenarios, cross-platform flows,
   protocol tests, golden files, fixtures, and user-visible specs.
2. Safety invariants: crash windows, cursor/watermark rules, path containment,
   atomicity, encryption, concurrency, lifecycle, and data preservation.
3. Legacy internal tests: unit tests coupled to the implementation being
   removed.
4. Implicit behaviors none of the three sources capture. A from-scratch rebuild
   silently drops exactly what is neither spec-mandated nor covered by a
   happy-path test. Before designing, inventory these four classes from the OLD
   code — each is greppable across the scope's files:

   - **Process-lifecycle semantics** — `relaunch()` vs `window.location.reload()`,
     process restart, cache/handle invalidation. A webview reload does not rebind
     Rust-held resources (filesystem watchers, DB handles) — only a restart does.
   - **Platform-specific glue** — Linux/portal events, and optional arguments a
     new caller can silently omit. Grep each helper's signature for optional
     params and confirm the new call sites still supply them where they carried
     behavior (TypeScript will not flag a dropped optional argument).
   - **Dev-only affordances** — every `import.meta.env.DEV` branch in the old
     files (`git show <base> -- <files> | grep -n 'import\.meta\.env\.DEV'`);
     confirm each is intentionally kept or dropped.
   - **Error / rejection paths** — every `catch` in the old files; a dropped
     `try/catch` turns a handled failure into an unhandled rejection or a lost
     user signal.

   Fold each surviving behavior into the contract as an explicit row, and record
   any deliberate drop in the ledger (or, in pruning mode, as a triage row).

For every legacy internal test, write one plain-English promise and classify it:

- **Fast**: durable invariant worth a small test against the new design.
- **Acceptance**: already covered better at a real boundary.
- **Core**: owned and tested by a lower-level canonical component.
- **Obsolete**: asserts retired implementation or protocol policy.
- **Follow-up**: meaningful behavior that lacks the right fault-injection seam.

Keep the old test name in the ledger so completeness is machine-checkable.
Verify the ledger row count equals the number of removed tests. Use the table
in `references/templates.md`, and read its classification pitfalls — each one
cost real review time in past rewrites.

Do not port test code first. That usually recreates the old architecture.
Translate promises first, design the new owner, then implement only the tests
that still make sense in the new vocabulary.

## Phase 4: prune the contract (opt-in, human-gated)

Skip this phase entirely unless pruning mode is active (see operating modes).
A behavior-preserving rewrite shrinks the implementation; pruning shrinks the
*specification* — that is where the compounding wins are, and it is a product
decision, never an agent decision.

1. Build a triage table over the scope's behavior inventory. Rows come from
   `docs/spec/<area>.md` lines (one behavior per line — the enumerable feature
   inventory) plus any externally observable behavior the contract extraction
   found that the spec missed. One row per behavior:

   | Behavior (spec line ref) | Evidence of value | Carrying cost | Proposal | Rationale |

   - Evidence of value: platform coverage, related Gap notes, churn/fix history,
     whether tests/scenarios exercise it, anything indicating real use.
   - Carrying cost: production LOC attributable to it, concepts/state it forces,
     platforms that must each implement it, test burden.
   - Proposal is one of **keep** / **simplify** (name the simpler behavior) /
     **drop**. Propose drop or simplify only where the carrying cost is real —
     do not pad the drop list to look thorough, and do not omit a costly
     behavior to avoid a hard question.

2. **Hard gate: present the table and stop.** Only the human approves drops,
   item by item. If running as a subagent that cannot ask, the triage table IS
   the deliverable — return it and do not proceed to design. Silence is keep.

3. Safety invariants are not features and are never triage rows: data
   preservation, crash recovery, path containment, encryption, sync
   convergence, and everything on AGENTS.md's CRITICAL list stay in the
   contract unconditionally.

4. For each approved drop or simplification, before designing the replacement:
   - update the `docs/spec/<area>.md` line (delete it, or rewrite it to the
     simpler behavior) in the same change, and regenerate gaps (M19);
   - delete the behavior's tests/fixtures/scenarios FIRST, then re-run the
     external gate so the baseline reflects the pruned contract — a dropped
     behavior whose test still passes is not dropped;
   - ledger every removed test under the **Dropped** disposition
     (`references/templates.md`), citing the approval.

5. The MR description gets a “Dropped behaviors” section: each dropped or
   simplified behavior, its old spec line, and who approved it. Drops must be
   auditable, never a side effect discovered in review.

The rewrite then proceeds against the pruned contract: Phase 5 designs the
minimum model the *remaining* behaviors need.

## Phase 5: design the smallest coherent replacement

Choose one owner for each state, lifecycle, and mutation sequence. The right
question is not “component versus helper” but “who may decide?” — e.g. the
shell rewrite's boundary was “who may decide whether the open draft is clean,
and who may replace or close it.” Build the minimum model needed by the
external contract.

Good replacement properties:

- one shared center with thin platform or transport projections;
- pure decisions separated from I/O;
- explicit state transitions and failure categories;
- atomic or recoverable destructive operations;
- public summaries/events composed once;
- no forwarding layers kept “just in case”;
- no parallel old/new implementation after consumers move;
- test seams around durable behavior, not private call order.

Before implementation, state what will be deleted. If the proposal mostly
moves the same code into more files, it is not the intended rewrite.

Proportionality: the payoff of a rewrite is deleted concepts and deleted
lines — every production line the replacement *adds* must be individually
justified by something the contract needs (a named test seam, a removed side
effect, crash recovery). Test seams must not outnumber the concepts they
test; prefer testing through the existing public surface over threading new
parameters purely for testability. And if contract capture reveals the scope
is already lean — little accidental architecture, tests already at the right
boundary — say exactly that and deliver a proportionate change (or none),
rather than manufacturing a rewrite to have something to show.

Use alternate branches and prototypes only to discover requirements, fixtures,
failure modes, or useful primitives. Measure them too. Reject them if they
recreate comparable complexity under new names.

## Phase 6: implement center-out

1. Implement the real external protocol or pure semantic center first.
2. Implement minimal persistence/state and crash recovery.
3. Move all consumers to the single new owner.
4. Collapse platform adapters to projections and callbacks.
5. Delete obsolete production modules.
6. Add translated fast tests and missing boundary tests.

When a full-stack test fails:

1. Describe the observable mismatch.
2. Identify the missing ownership or reconciliation rule.
3. Fix that shared rule at the lowest correct boundary.
4. Add a focused regression test only if the external suite cannot localize the
   failure cheaply.
5. Rerun the narrow test, then the full external gate.

Never soften assertions, add sleeps, raise timeouts without evidence, or make a
test green by retaining a dead abstraction.

Expect the ledger audit to find real bugs in the OLD implementation (the sync
audit found three data-safety gaps). Fix them in the new implementation and
name them in the report — they are the audit's proof of value.

## Phase 7: verify in layers

Run, in order:

1. formatter and static checks;
2. new fast tests;
3. complete subsystem tests;
4. every direct consumer’s build/tests;
5. real-service/protocol tests;
6. E2E, cross-platform, simulator, or comparison-oracle suites;
7. strict lint/clippy/type checking;
8. diff integrity and clean-worktree checks.

Then fetch/rebase current main and repeat all affected layers. Resolve conflicts
by preserving unrelated main changes and the new ownership boundary. A
modify/delete conflict on a deliberately removed module normally stays deleted;
inspect rather than blindly choosing a side.

Report exact pass counts. “Tests pass” is insufficient for a risky rewrite.
**Vacuous-green check**: the scope's default test command must *execute* a
nonzero number of tests, and you report the count. “`cargo test -p X` passed”
while running 0 tests (everything deleted or `#[ignore]`d) is silent green
wearing a test suite — a draft of the sync rewrite failed review on exactly
this.

### Behavioral parity sweep (ask first)

A green external gate does not prove parity: it only covers behavior some test
asserts, and a from-scratch rebuild's regressions cluster in the Phase 3 blind
spots that no test guards. Before declaring success, **ask the requester whether
to run a parity sweep.** It is cheap and has repeatedly caught silently-dropped
behavior; run it unless they decline.

The sweep is a direct old-vs-new diff for the four blind-spot classes:

    git diff <merge-base>...HEAD -- <rewritten paths> \
      | grep -E '^-.*(catch|relaunch|import\.meta\.env\.DEV)'

Every removed `catch`, `relaunch`, or dev-only branch is a "prove this was
intentional" item — either a regression to restore or a deliberate drop to
record in the ledger. Re-read each helper whose optional argument the new
callers stopped passing.

Then sweep the added comments against the repo comment standard — a from-scratch
rebuild over-comments. Delete comments that restate the code; keep the ones that
justify a non-obvious decision (an empty catch, a magic constant, a spec
reference, a render/lifecycle gate).

## Phase 8: measure and audit the result

Compare before and after:

- production lines, excluding tests and docs — count production and test lines
  separately, and never present deleted tests as “code reduction” (the other
  point the sync-rewrite draft failed review on; if the honest number is 32%,
  report 32%);
- number of production modules and concepts removed;
- public APIs and consumers preserved;
- fast, integration, and E2E coverage counts;
- remaining follow-up gaps;
- any intentionally changed behavior;
- in pruning mode: behaviors dropped/simplified, each with its approval.

Reconsider the design if the replacement is similarly large, has similarly
giant owners, or needs compatibility adapters for the old private architecture.

## Phase 9: publish the reasoning

When authorized, create intentional commits, push the branch, and open/update
an MR. Put the full writeup in the MR description, not only in a repository doc.
Use `references/templates.md` for the structure.

For crate/subsystem scopes, create one canonical learning document containing:

- outcome and measurements;
- central boundary/ownership lesson;
- reproducible worktree and external-service setup;
- safety invariants;
- failure-derived rules;
- complete legacy-test ledger;
- verification matrix;
- follow-up queue.

Do not split the same learning across several overlapping documents.

## Stop conditions

Stop and request direction when:

- the candidate lacks an executable external contract;
- preserving behavior requires a product decision not present in specs/tests
  (in pruning mode, package the decision as a triage row instead of stopping);
- a safety-critical failure mode cannot be observed or injected;
- required external infrastructure or credentials are unavailable;
- completion would require broadening scope to a materially different system;
- anything on AGENTS.md §11's stop-and-ask list is in play (keys, CRITICAL
  guards, hash/crypto, protocol shapes, destructive ops on real data).

Do not stop merely because the rewrite is large or difficult. Add coverage,
reduce the boundary, or continue iteratively while the external contract remains
authoritative.

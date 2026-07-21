# Learning: contract-rewriting the Svelte desktop shell

**Branch:** `rewrite/svelte-frontend` · **Scope:** `src/` minus the frozen editor surface · **Campaign:** docs/plan/contract-rewrite-campaign.md

## What was done

A five-phase contract rewrite of the Svelte frontend: (1) a nine-agent triage
of every spec behavior and unspecced affordance in scope (~89 rows), gated
item-by-item by a human before any code moved; (2) characterization tests for
spec-mandated behavior that had zero coverage (M1 render gate, watcher
idempotence, settings state machine, search presentation); (3) the approved
prunes and simplifications, one commit each; (4) deletion of the shell
composition layer and re-creation from docs/spec by an agent that never saw
the old code; (5) race fixes the fresh implementation surfaced.

## What we learned

### 1. The LOC reduction lives in the pruning gate, not the rewrite

Production `src/` shrank ~1,100 lines net. Essentially all of it came from the
human-gated triage (dead graph feature, orphan CSS, unused pool, bespoke drag
layer, inline virtualization, duplicate toast/delete machinery). The
from-scratch rebuild itself was LOC-neutral (+1 line). On a codebase that has
already been through architecture hardening and prior contract rewrites, the
remaining size is essential complexity: a fresh implementation of the same
spec lands at the same size. Expect compression from the _triage_, and treat a
LOC-neutral rebuild as evidence the spec — not accident — is driving the size.

### 2. The rebuild's real yield is latent bugs

Re-deriving the shell from the spec surfaced three real defects the old code
hid: the title controller scheduling saves without updating session state
(sync persisted "Untitled"), pending editor saves racing Rust rename/move
workflows (old paths recreated after the move), and concurrent
`saveConfig` read-modify-write cycles clobbering each other's fields. All
three are the M6/M7 failure class — ordering invariants stitched at call
sites — and all three fixes push the invariant down into the owning module
(note session save lock; config store write queue). Each is regression-locked.

### 3. Two contract rewrites can collide and converge

Mid-flight, main landed an independent contract rewrite of the Tauri platform
adapter touching the same files. Reconciliation notes for next time:

- Both rewrites independently found and fixed the watcher double-start race
  with the identical cached-promise pattern — a good sign that
  contract-derived fixes converge.
- A file that was dead at branch time (`appConfig.ts`) became the live config
  store on main. A prune verified against the merge base must be re-verified
  after every rebase; "zero importers" is a statement about a commit, not a
  file.
- Git's rename tracking merged our test edits into main's renamed/moved test
  files cleanly, but each auto-merge was reviewed by hand — one of them
  (`appConfig.test.ts`) carried a regression test for a queue the rebased
  implementation didn't have yet, which is exactly the failing-first test the
  port needed.
- The campaign rule of one rewrite in flight exists for this reason; when it
  is violated by circumstance, rebase commit-by-commit and port semantics, not
  hunks.

### 4. Fresh eyes need a written contract, not a clean context alone

The rebuild agent worked from a handoff document (kept seams, test-hook
surface, acceptance gate, "no git archaeology on deleted paths") plus
docs/spec. The characterization tests written in phase 2 were what made the
acceptance gate meaningful: the M1 gate, watcher, settings, and search tests
all predate the deletion, so "rebuilt shell passes them" is evidence of
behavior preservation rather than self-confirmation.

### 5. Session-limit deaths are a planning input

The first rebuild agent died mid-task on a session limit with partial
untracked files. The work was salvaged because every completed phase was
already committed and the handoff document existed independently of the dead
agent's context. Commit at phase boundaries; keep the handoff in a file, not
in a prompt.

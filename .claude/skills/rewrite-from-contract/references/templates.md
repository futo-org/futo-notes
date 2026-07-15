# Templates: ledger, MR description, learning document

## The test-disposition ledger

The ledger is what makes deleting tests defensible. Removing N tests together
with an old implementation is acceptable only if each one was first treated as
**evidence about product behavior** — translated into a plain-English promise
and explicitly dispatched. The goal is never to preserve old class/function
boundaries; it is to preserve observable behavior and data-safety invariants
while letting the implementation be genuinely different.

Two complete worked examples live on main — read the one closest to your
scope's layer:

- `docs/learnings/sync-rewrite.md` — 171 Rust tests (sync crate rewrite)
- `docs/learnings/notes-shell-session-sync-rewrite.md` — 61 TS tests (shell rewrite)

One row per removed test, four columns. The "New evidence" column is what
turns a claim into something a reviewer can check. Row count must equal the
number of removed tests — verify this mechanically.

| Removed test | Plain-English promise | Disposition | New evidence |
| --- | --- | --- | --- |
| `cap_cursor_holds_below_lowest_failed_change_seq` | A failed remote change prevents the cursor from advancing past that change. | **Fast** | `cursor_never_advances_past_the_first_failed_change` |
| `login_password_maps_401_to_bad_password` | A rejected password produces an auth error, not a generic sync failure. | **Acceptance** | `server_integration::raw_error_contract` |
| `filename_basename_strips_path_prefix` | Move matching compares the basename independently of folder. | **Core** | owned by `futo-notes-core` tests |
| `plan_download_jobs_packs_smallest_first_under_byte_cap` | The retired batch planner packed downloads under a byte budget. | **Obsolete** — the server has no batch endpoint; transport policy, not product behavior. | — |
| `run_pull_caps_cursor_on_failed_download_and_retries_next_pull` | A failed blob is retried next pull; later changes are not skipped. | **Follow-up** — decision rule is fast-tested; the failing-blob transport boundary still needs fault injection. | follow-up queue #1 |

### Disposition burdens

- **Fast** — reimplemented in the new design's vocabulary (external state,
  files, public summaries). Never resurrect old planner/mock/adapter APIs to
  port a test — that quietly rebuilds the architecture the rewrite replaced.
- **Acceptance** — must name the exact suite and scenario. "Covered by
  integration tests" with no name is not a disposition; it's a hope.
- **Core** — name the lower-level canonical owner. Duplicating it would create
  two authorities.
- **Obsolete** — highest burden: name the retired mechanism and say why it was
  policy, not product behavior. "Old test, new code" is never a justification.
- **Follow-up** — a named debt, not a deletion: goes in the numbered follow-up
  queue with the smallest fault-injection seam that would exercise it.
- **Dropped** — pruning mode only: the behavior itself was removed from the
  contract with explicit human approval. Cite the approval and the removed
  `docs/spec/` line. Never self-approved; a Dropped row without a named
  approval is a defect.

### Classification pitfalls (each cost real review time)

1. **Obsolete-washing.** Marking a safety behavior Obsolete because its *test*
   was ugly. Test ugliness is evidence about the old architecture, not about
   the promise. If the promise mentions user data, cursors, tombstones, or
   convergence, it is almost never Obsolete.
2. **Acceptance hand-waving.** An Acceptance row that doesn't name a scenario.
   If you can't point at one, add one or reclassify as Fast/Follow-up.
3. **Porting before translating.** Deciding dispositions by reading test *code*
   instead of writing the promise first. Ported test code imports the old seams
   and drags them back in.
4. **Losing the audit's findings.** The translation pass regularly finds real
   bugs in the OLD code (the sync audit found three). Fix them in the new
   implementation and list them in the report.
5. **One promise, several tests.** Many old tests are the same promise probed
   at different seams. Collapse to one row-group and one strong replacement
   test — but every removed test name still appears in the ledger.

## MR description / final report structure

The full writeup goes in the MR description itself, not only a repo doc:

```
# Summary
<what was replaced, honest production-line delta counted excluding tests,
 what one API replaced which layers, which invariants were preserved>

# What changed
<new module responsibilities, consumer migration>

# Why a rewrite instead of incremental refactoring
<the accidental-architecture evidence>

# What happened to the N old tests
<disposition totals: X fast / Y acceptance / Z obsolete / W follow-up
 (+ V dropped, pruning mode only);
 bugs the audit found in the old implementation; ledger location>

# Dropped behaviors (pruning mode only)
<each dropped or simplified behavior: old docs/spec/ line, what replaced it
 (nothing / the simpler behavior), and who approved the drop>

# What the full-stack failures taught us
<failure-derived ownership/ordering rules, stated as shared-engine rules>

# Verification
<every layer: exact command + N/N counts, including pre-rewrite baseline
 numbers and the post-rebase rerun>
```

## Learning document structure (crate/subsystem scopes)

One canonical document at `docs/learnings/<scope>-rewrite.md` — never split
the same learning across overlapping documents:

1. Outcome and measurements (before/after table: production lines, owners,
   callbacks/concepts, test counts per layer)
2. Central boundary/ownership lesson ("who may decide X")
3. Replication playbook (worktree, isolated external services, exact baseline
   commands and their recorded results)
4. Safety invariants (plain English, implementation-free)
5. Failure-derived rules (what acceptance failures forced into the model)
6. Complete legacy-test ledger (format above)
7. Verification matrix
8. Follow-up queue (numbered, each with its smallest fault-injection seam)

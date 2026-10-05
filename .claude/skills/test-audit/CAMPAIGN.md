# Campaign mode

A campaign audits every test in a scope: one subsystem, or the whole repo.
Sampling is the default audit's job; a campaign ends only when the **ledger**
has a verdict for every test file in scope.

## The ledger

Enumerate the scope from `git ls-files`, never from memory or a grep someone
remembered:

- TS/JS: `*.test.{ts,mjs}`, `*.spec.ts` (co-located units, `scripts/`,
  `tests/`, `packages/editor/`);
- Swift: `apps/ios/Tests/`, `apps/ios/UITests/`;
- Kotlin: `apps/android/**/src/{test,androidTest}/`;
- Rust: every `.rs` file carrying `#[test]`, `#[tokio::test]`, or `proptest!`
  (inline modules and `tests/` dirs alike);
- real-app harnesses: `tests/*.mjs`, `tests/conformance/*.mjs`,
  `tests/milkdown-census/`.

The `tests/conformance/*.json` and `tests/localization/` goldens are out of
scope: editing one is a human decision about intended behavior.

Each ledger row is one file: path, test count, reviewer verdict (`keep` or
`candidates`), and the candidates it produced. A row with no verdict is
**unreviewed**, and the campaign is not done while one exists.

## Shards

Pack files into shards of roughly 100–150 tests, grouped by owner directory so
one reviewer reads the production owner once for all its tests. Never split a
file across shards.

## Stages

1. **Review** (one agent per shard): read every test in every file, apply the
   junk patterns and retention bar from `SKILL.md`, and return a verdict for
   every file plus the full candidate evidence for each candidate. Returning
   fewer files than the shard holds is a failed review; the orchestrator
   re-dispatches the missing files.
2. **Verify** (one agent per shard with candidates, independent of the
   reviewer): try to *refute* each candidate. Re-read the test and owner, rerun
   the caller grep, open the named stronger proof and confirm it covers the
   same failure, check CI lists, and apply the retention bar. Uncertain means
   refuted.
3. **Synthesis** (orchestrator): group surviving candidates into coherent
   owner-boundary batches, one MR each, ranked by confidence and production LOC
   unlocked. Record refuted candidates in the ledger as retained, with the
   verifier's reason, so the next campaign does not rediscover them.

Discovery and verification are read-only. Reviewers never run builds or
suites; the worktree is shared by every lane, so no lane edits files, stashes,
or switches branches.

## Landing

Land batches through the normal audit **Edit shape** and **Validation**
sections, one MR at a time. The orchestrator re-reads each candidate before
editing: a verified ledger row is a lead, not a license.

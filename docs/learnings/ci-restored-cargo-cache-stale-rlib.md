# A restored cargo cache can link against a crate that no longer exists

Date: 2026-08-03

## Summary

Pipeline 33129 on `main` (job 211040, `build:android-native`) failed with 13 Rust
errors of the form:

```
error[E0433]: failed to resolve: could not find `OpenNoteDisposition` in `sync`
   --> crates/futo-notes-ffi/src/sync/contract.rs:122:19
error: could not compile `futo-notes-ffi` (lib) due to 13 previous errors
```

Every one of those symbols was exported, unconditionally, from
`crates/futo-notes-sync/src/lib.rs` at that commit. Nothing was wrong with the
source. A bare retry of the same job on the same commit (job 211073) went green.

The class of bug is **an artifact cache making a compiler skip work it needed to
do**. It is the CI twin of the APFS-clone trap already recorded for local
`target/` copies: restored artifacts look newer than freshly checked-out
sources, so cargo — which decides freshness by mtime and never by content —
calls a stale rlib fresh.

## Root cause

Counting compile lines in each trace is what proves it (CI masks the project
name, so grep for `Compiling \[MASKED\]-sync`, never the real crate name):

| job | `Compiling …-sync` | `Compiling …-ffi` | outcome |
| --- | --- | --- | --- |
| 211040 | 0 | 1 | failed |
| 211073 (plain retry) | 4 | 4 | success (4 = the Android ABIs) |

The cargo caches are keyed on `Cargo.lock` alone. `open_note.rs` was added
without a lockfile change, so the key was unchanged and the job restored a
`target/` holding a `futo_notes_sync` rlib built before that module existed.
Cargo skipped the sync crate, rebuilt `futo-notes-ffi` against the stale rlib,
and the new symbols were simply absent.

Two facts scope it:

- **MR pipelines and protected-branch pipelines use different caches.** !166's
  own pipeline ran the identical job green on the MR cache; only the protected
  cache was poisoned. "The MR was green" is not a defense.
- `refs/merge-requests/N/head` is the branch head, not branch-merged-with-main,
  so MR pipelines never test the merge result at all.

## Fix

`scripts/ci-cargo-cache-freshness.mjs`, run from `.setup-rust` — the one anchor
every job that restores a cargo `target/` already references. It keeps
`target/.ci-source-stamp`: the commit whose sources the mtimes in that tree
correspond to. When the stamp disagrees with `HEAD`, the files that changed
between the two commits are touched, so cargo rebuilds exactly those crates and
still reuses every third-party artifact. An unstamped or unresolvable stamp
touches every cargo input instead — slower, never wrong.

Alternatives rejected:

- **Hash `crates/**` into the cache key.** Correct, but any Rust edit then
  throws away the whole dependency tree; `build:android-native` swings 8m warm →
  45m cold.
- **Unconditionally touch the workspace.** Correct and two lines, but it forces
  a full workspace recompile on every run of six jobs that serialize on one
  office runner.
- **Stop caching `target/` for crates under change.** Cargo has no such
  granularity, and per-crate cache surgery is guesswork about what is stale.

`scripts/ci-cargo-cache-freshness.test.mjs` red-proofs both halves: the guard's
`--check` mode fails on a skewed tree, and a deny-by-default sibling check fails
if any job that restores a cargo `target/` stops routing through `.setup-rust`.

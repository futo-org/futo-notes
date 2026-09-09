# Search index hill climb — 2026-09-06

Starting point: remote `main`, `6d59965d`. Worktree:
`../futo-notes-perf-20260906`, branch `perf/hill-climb-20260906`.

## Measurement setup

The benchmark calls the public `SearchEngine`, including its background reconcile,
readiness notification, and runtime lifecycle. It creates and removes its own
temporary vault and index; it never opens an application vault. The corpus has
5,000 notes by default, 20 folders, four topic groups, tags, mostly short bodies,
some medium bodies, and occasional large bodies. It is synthetic, with a small
vocabulary: query times are a sanity check, not a representative search-quality
or real-corpus latency claim.

`unchanged_rescan` measures from requesting a rescan to the completion callback.
`warm_start` includes opening an existing index, waiting for reconciliation, and
dropping the engine. Neither is a full application launch or a cold disk-cache
measurement. Query result counts are checked before timing. Readiness waits have
a deadline and fail if the engine does not finish.

Host: Linux, Intel Core i9-14900K, NVMe/btrfs, Rust 1.89.0, optimized Cargo bench
profile. Criterion uses 30 samples (10 for startup), one second of warmup, and a
three-second measurement target. Raw logs and profiles live in `perf-results/`;
Criterion JSON lives in `target/criterion/`. Both directories are gitignored.

## Reproduce

```sh
just install
just test-search

# Run on the base revision with the benchmark harness, then on the change.
taskset -c 0,2,4,6 just bench-search --save-baseline main
taskset -c 0,2,4,6 just bench-search --baseline main

# The note count is part of the benchmark ID, so corpus sizes do not overwrite
# one another. Save this size on the base revision before comparing the change.
SEARCH_BENCH_NOTES=10000 taskset -c 0,2,4,6 just bench-search \
  'search/(unchanged_rescan|warm_start)' --save-baseline main

# Save intermediate hills under separate names. Criterion 0.5 does not allow
# --save-baseline and --baseline in the same invocation.
taskset -c 0,2,4,6 just bench-search \
  'search/(unchanged_rescan|warm_start)' --save-baseline intermediate

perf record -e cycles:u -F 199 -g --call-graph dwarf \
  -o perf-results/search-rescan.data -- \
  taskset -c 0,2,4,6 just bench-search search/unchanged_rescan --profile-time 10
perf report --stdio --no-children -i perf-results/search-rescan.data
```

Choose suitable CPU numbers on your machine. `taskset` is Linux-specific and is
optional on machines without heterogeneous cores. The first unpinned run showed
all query timings falling by roughly half despite no query-path edit, so those
comparisons are excluded from the final claims. Fixed-core comparisons use the
same original and candidate binaries, fixture generator, and dependency lock.
The 50 MB writer budget limits Tantivy to three indexing workers with or without
this four-core affinity, so the worker count is unchanged.

## Results

Criterion mean estimates in milliseconds, from the fixed-core runs. The base
binary contains the original engine plus the benchmark harness (`9bc1d212`);
the final engine is `9cf1f3d9`.

| Notes  | Operation          |  Main | Final | Less time |
| ------ | ------------------ | ----: | ----: | --------: |
| 5,000  | Unchanged rescan   |  5.24 |  4.19 |     20.0% |
| 5,000  | Warm index startup |  6.18 |  4.88 |     21.0% |
| 10,000 | Unchanged rescan   | 11.60 |  9.07 |     21.8% |
| 10,000 | Warm index startup | 12.12 |  9.97 |     17.7% |
| 50,000 | Unchanged rescan   | 73.27 | 60.90 |     16.9% |
| 50,000 | Warm index startup | 75.41 | 63.45 |     15.9% |

The final exact, prefix, multi-word, typo, and missing-query cases remain around
26–36 microseconds at 5,000 notes, close to the fixed-core base. No query-path
speedup is claimed. Empty commits no longer rewrite the persisted metadata;
the regression checks this independently of noisy wall-clock timing.

The first two changes together reduced the 50,000-note rescan mean from 73.27
to 64.39 ms. Reusing note IDs reduced it further to 60.90 ms. At 5,000 notes the
first pair's rescan result was inconclusive; the final implementation shows a
clear gain. This is why the table reports the completed, controlled comparison
instead of the much larger preliminary unpinned numbers.

Recorded runs:

- `perf-results/search-pinned-main.log` and `search-final-5000.log`.
- `perf-results/search-pinned-main-10000.log` and `search-final-10000.log`.
- `perf-results/search-pinned-main-50000.log` and `search-final-50000.log`.
- `perf-results/search-summary.json`: the table's unrounded mean estimates.

For the fixed-core comparison the already-built executables were copied to
`perf-results/search-main` and `perf-results/search-final` and run directly with
`taskset -c 0,2,4,6`, `--bench`, and the Criterion baseline arguments. This kept
compilation out of timed runs. Full suites were started only after measurement.

## Changes

### 1. Do not commit an unchanged index

Every reconcile called `IndexWriter::commit`, even when the mtime gate skipped
every note. Tantivy's empty commit still persists index metadata and joins and
replaces indexing workers. `TantivyIndices` now owns a pending-changes flag,
set by upserts and deletes and cleared only after a successful commit. Its writer
is private so callers cannot bypass this tracking.

Reader reloads still happen: they expose completed background merges and retry a
previous reader failure. Commit failure leaves pending changes available for the
next retry. No persisted schema or search behavior changes.

`committing_without_changes_leaves_the_persisted_index_untouched` fails against
the original implementation and passes after the fix. A second test blocks
`meta.json` with a directory, checks that commit fails, removes the obstruction,
and verifies that the next commit persists the pending note without a new upsert,
including after reopening the index.

### 2. Stream reconciliation metadata in storage order

`bm25_note_mtimes` previously collected all document addresses in a hash set,
then fetched their stored fields in random order. CPU profiling showed stored
block reads, skip-index seeks, and allocation among the costs. The new code
iterates each segment's stored documents sequentially, decoding each block once
without populating the query cache or allocating the address set.

The segment's live-document bitmap is passed to Tantivy's iterator. A test with
merging disabled verifies multiple segments, replaced and deleted documents,
Unicode note IDs, zero mtimes, uncommitted writes, and reopening the index.

### 3. Normalize each note ID once per walk

The file inventory now carries normalized note IDs, which reconciliation borrows
for its deletion set and mtime lookup. It no longer normalizes each ID separately
for both operations or allocates another owned copy for the set. A nested Unicode
fixture verifies warm skipping, `.md` and `.txt` IDs, and removal of the old ID
after an external rename. The path-conversion rules themselves are unchanged.

## Verification

- `just check`: passed, including architecture/contract gates, Rust/TS rule
  conformance, formatting, lint, Svelte/TypeScript checks, 1,834 app/tool tests,
  381 editor-package tests, and the production web build. Existing lint and Rust
  warnings remain.
- `just test-search`: 27 passed; the pre-existing optional one-shot performance
  test remains ignored. The new benchmarks use a separate Cargo bench target.
- `just test-rust-full`: all 516 non-Tauri Rust tests passed, including the store
  and UniFFI consumers; 64 Tauri tests passed. The suite failed in the existing
  `system_trash::tests::portal_trash_removes_a_regular_file` test because the live
  OS portal declined its disposable probe. Environment-dependent sync integration
  tests remain ignored by this standard command.
- The same isolated portal failure reproduced with both changed search source
  files temporarily restored from `6d59965d`; the Tauri trash code is identical
  to that revision. The search changes were restored afterward. No test or gate
  was weakened, and both failed tests' exact temporary files were removed.
- The doctest targets for all seven workspace crates completed separately after
  the suite aborted (zero executable doctests), using `just test-search` with
  each consumer's `-p` argument and `--doc`.

Logs: `perf-results/check.log`, `test-rust-full.log`,
`search-step3-tests.log`, `rust-doctests.log`, and `trash-original-search.log`.

## Scope and next candidates

The shared search crate is used by desktop, iOS, and Android. These measurements
exercise that Rust owner on Linux; they do not establish device timings, keyboard
latency, or a full native or desktop launch improvement.

The initial survey also inspected the local Go server's indexed object listing
and session lookup and the native bootstrap callers. No server change was made.
Native first-list hydration still calls the full-body `bootstrap` projection;
the desktop has a separate stat-only `startup_listing`. That is a candidate for a
separate device-measured climb. The existing `perf/hill-climb` branch already
contains connection-pool reuse, unchanged sync-checkpoint avoidance, and narrower
save collision walks; this branch does not duplicate those changes.

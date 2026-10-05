# Vault open hill climb — 2026-09-25

## The metric

Vault open is `LocalNoteStore::bootstrap_with_search`: walk the vault, derive each note's preview,
rich preview and tags, start search. iOS and Android gate their first note-list frame on it;
desktop paints from `startup_listing`, then hydrates from the same call. A search query costs
~30 µs and sync is bound by the network, so this is the Rust cost people wait on most.

## Method

`crates/futo-notes-store/benches/vault_open.rs` (`just bench-vault`):

- **Corpus.** A deterministic synthetic vault of 10,000 notes, with long-tailed sizes (median
  ~600 B, a few near 768 KB), up to three folders deep. It includes tags, tasks, tables, code
  fences, inline code, images, `<br />` and non-ASCII text.
- **Iterations.** Each one opens a fresh store over the same vault and index dir, as a relaunch
  does.
- **Host.** jfedora (Linux, i9-14900K, tmpfs), pinned to eight P-cores
  (`taskset -c 0,2,4,6,8,10,12,14`), one benchmark at a time.
- **Baseline.** `main` is the same bench file run against the original code.

## Results

| 10k notes | main | now | change |
|---|---:|---:|---:|
| **Relaunch** (`bootstrap_with_search`) | 37.2 ms | **4.49 ms** | −87.9% (8.3×) |
| First launch, no cache (`bootstrap`) | 37.6 ms | 19.3 ms | −48.6% |
| Desktop first frame (`startup_listing`) | 8.63 ms | 1.88 ms | −78.2% |
| Flat vault, every note in the root | 34.4 ms | 19.4 ms | −43.6% |
| `save` / `create` p50 (`tests/perf_save.rs`) | 7.47 / 7.39 ms | 1.62 / 1.58 ms | −78% |

Of the 4.5 ms relaunch, ~1.3 ms is freeing the returned snapshot's ~65k strings and ~0.5 ms is
the search engine starting; the rest is one stat per note plus the cache lookups.

## What changed

1. **The list cache** (`store/src/list_cache.rs`). Each note's derived fields are persisted at
   `<index_dir>.list-cache`, outside the vault, so a relaunch reads no unchanged note.
   - **When an entry is trusted.** Only on an exact stat fingerprint. On Unix that is length,
     mtime, ctime, inode and device; ctime catches sync's post-write mtime restore. The entry must
     also be at least 2 s older than the pass that last verified it, which covers coarse clocks
     (ext4, FAT).
   - **What the file carries.** The vault root, and a checksum of the derivation rules' output
     over probe strings, so a rule change retires old caches by itself.
   - **How it is read and written.** Records are sorted by id and parsed zero-copy, with fields
     UTF-8 checked only when read. A corrupt or mismatched file is a cold start. It is rewritten
     only when content changed, off the calling thread.
2. **A parallel walk** (`store/src/vault.rs`). Folders, and each folder's notes, are visited in
   parallel with std's `read_dir`, whose `DirEntry::metadata` stats relative to the directory fd
   on Linux and Android. A folder is closed before its subfolders open, so descriptors stay
   bounded; `tests/fd_limit.rs` walks 400 folders under a 64-descriptor limit.
3. **Cheaper derivation for cache misses.**
   - Previews jump between `!` and `<` with `memchr`.
   - Tags come from one pass that treats code regions as byte ranges, instead of blanking two
     copies of the note and running a regex fence scan.
   - Bodies are UTF-8 checked with `simdutf8`.
4. **The crash-recovery scan** before every open visits sibling folders in parallel.

## Correctness

- **End to end.** A probe built against `main` and against this branch dumped every vault-open
  projection for the same 5,000-note vault: cold, warm, after sync-like edits (including a
  same-size edit with the mtime restored), and warm again. All were byte-identical. The vault
  held adversarial files: invalid UTF-8, a BOM, CRLF, symlinked files and folders, non-UTF-8 and
  backslash names, a chain past the depth cap, a hidden folder, and `.txt` migration.
- **In the test suite:**
  - The cache's end-to-end test, which runs a planted-entry hit and edits made behind the store's
    back through `bootstrap_with_search`.
  - A walk test for hidden entries, symlinks and the depth cap.
  - A test that a racy entry is promoted once it ages out.
  - The fd-limit test.
  - Exhaustive pins of the tag scanner's fence and inline-code passes against the regexes they
    replace.
  - The existing conformance goldens.

## Limits

- **Hosts measured.** Only one fast Linux host with a warm page cache. Phones were not measured;
  the Android FUSE storage makes each read dearer, which should favor the cache.
- **Windows cache validator.** Windows gets a weaker fingerprint (length, last-write and creation
  time), because stable std exposes no ctime or file id there.
- **Memory.** The cache costs ~450 B per note on disk and in memory.

## Tried and dropped

- **A dirfd-based walk (rustix).** It made the cold open ~4 ms faster, at the cost of ~700 lines
  including its equivalence tests.
- **Bounded, fused preview scanning.** Slower than the `memchr` fix.
- **A lazy Tantivy writer.** It broke the engine's retry on a locked index.
- **Starting search alongside the snapshot.** Slower: they compete for the same cores.
- **Parallel chunked cache loads and index-permutation sorts.** Within noise.

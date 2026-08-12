# Search — Spec

Search is on-device keyword retrieval owned by the same local-note store that
owns the Markdown vault. The store starts one Tantivy BM25 engine per vault;
desktop, iOS, and Android query that owner through thin adapters.

## Behavior

- No query or note content leaves the device.
- Bootstrap starts index reconciliation in the background so list rendering
  never waits on search startup.
- A non-empty query waits for keyword readiness, then returns ranked note IDs.
  The wait is a single bounded engine call
  (`LocalNoteStore::wait_until_search_ready`); shells pass a budget and
  degrade to empty results when it elapses — no shell owns a readiness poll
  loop, and there is no TypeScript, Swift, or Kotlin fallback index.
- The index covers note title, folder, tags, and body text.
- Internal hyphens are parsed as an adjacent phrase by the shared Tantivy query
  behavior (`folder-scoped` matches the compound, not distant words).
- A multi-word query prefers notes containing EVERY word: retrieval runs
  all-words first, and only falls back to any-word when no note contains them
  all. BM25 alone ranks a short one-word match above a long all-words match.
  → `futo-notes-search` `TantivyIndices::run_pass`
- A query that matches nothing exactly retries at edit distance 1, so one
  mistyped character returns the note instead of an empty list. Fuzzy is a last
  resort only — an exactly-spelled query is never diluted by near-spellings.
- A query ending mid-word matches its last word as a prefix (`Aug` retrieves a
  note titled `August 10, 2026`); earlier words still match as typed. Trailing
  whitespace or punctuation ends the word, so `Aug ` matches only the literal
  word — shells must not trim the query's tail. A tail glued to punctuation
  (`folder-sco`) is not prefixed, preserving hyphen-compound adjacency.
  → `futo-notes-search` `tantivy_indices::split_trailing_prefix`
- Terms match as typed: there is no stemming, so `meeting` does not retrieve
  `meetings`. Measured on a 2,608-note corpus, adding the English stemmer cost
  more ranking quality on exact titles than it recovered on word variants.
- Ranking is BM25 with two bounded adjustments: title matches are boosted 2×,
  and a recency multiplier (up to 2×, halving every 30 days of note age)
  prefers recently modified notes among comparable matches — so a fresh daily
  note titled with the query word outranks an old note whose body repeats it.
  → `futo-notes-search` `TantivyIndices::run_pass`
- Retrieval is lexical. There is no semantic/embedding search, so a query
  sharing no words with a note will not find it.
- Empty-query UI behavior remains surface-specific: desktop and Android show
  eight recent notes; iOS shows the normal current-folder list.
- Result rows show title, preview, and a folder badge for foldered notes.

## Ownership and consistency

- `futo-notes-search` implements BM25 and background reconciliation.
- `futo-notes-store::LocalNoteStore` owns its lifecycle and feeds it every
  committed local mutation.
- Tauri exposes this owner through
  `local_notes_search/wait_until_search_ready/rescan`; UniFFI exposes
  the same calls on `NoteStore`.
- A mutation is visible to the index as part of the store workflow. Shells do
  not issue per-file search notifications.
- Sync and external filesystem writes bypass local workflows, so each completed
  peer batch or watcher batch requests one store rescan. Pure push echoes do not.
- Debounced index changes converge regardless of arrival order: an upsert whose
  file no longer exists on disk removes the stale document, so a peer rename
  delivered as remove-then-change never leaves the old id searchable until
  restart. → `futo-notes-search` `indexer::apply_pending`
- Full reset clears the vault through the store and leaves the rebuildable index
  owned by that same instance.
- A failed engine start (bad/locked index dir, momentary disk pressure) degrades
  to empty results rather than crashing, and the store re-attempts the start
  lazily on the next search/wait/rescan call — gated by a 15 s cooldown
  (`SEARCH_ENGINE_RETRY_COOLDOWN`) so a persistent failure is not reopened on
  every call. This self-heal lives in the shared `futo-notes-store` owner, so
  iOS, Android, and desktop share it (it replaces the former iOS-only
  `SearchService` retry). → `futo-notes-store` `ensure_engine`

## Desktop UI

- The drawer search affordance and Ctrl/Cmd+P open the autofocused popup.
- Queries debounce about 100 ms.
- Arrow keys select results, Enter opens, Escape closes, and the clear button
  resets the query.
- Ctrl/Cmd+click, Shift+click, or middle-click opens a result in a new tab.
- A query with no matches shows a "No notes found" empty state.

SPLADE/learned-sparse search is not part of this contract.

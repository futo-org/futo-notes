### 2026-08-24 — Step 0 corpus census — base complete; causal follow-up stopped

- **Candidate revision:** `poc/bakeoff-census` at `aae8969e`; corpus SHA-256
  `1edbcf888da2d3fe633cf10c838cd811d14bf8957dda3d0f4ae3aaa2a21adc32`.
- **Coverage:** four strict shards merged to exactly 30,995/30,995 notes and
  104,201,276 UTF-8 bytes, with zero load failures, identity serialization
  failures, or identity mismatches. The strict merge rejects missing,
  duplicate, overlapping, differently configured, and differently fingerprinted
  shards.
- **Block-map burden:** 3,720 notes (12.0019%) failed the exact-only block map:
  3,700 `blockNodeMismatch`, 19 `tokenRawMismatch`, and one
  `incompleteSourceCoverage`. The largest divergence classes were HTML→list
  (2,134), HTML→paragraph (867), HTML→heading (350), and HTML→end (154).
- **Edited-block census:** 194,715 sampled edits: 163,579 clean (84.0094%),
  22,147 silent rewrites (11.3741%), and 8,989 refusals (4.6165%). Refusals
  occurred in 5,598 notes (18.061%): 7,578 unowned-HTML and 1,411 semantic
  round-trip failures. Internal undo changed the TipTap document in 81,804
  trials; 81,802 reset byte-exactly and two were explicit identity-refused
  baseline failures. There were zero source/editor block-count mismatches.
- **Construct histogram:** labels co-occur and therefore describe burden rather
  than causal attribution. The leading clean labels were paragraph (88,092),
  ATX heading (48,579), heading block (47,746), wikilink (19,173), and Markdown
  link (15,350). Rewrites most often co-occurred with list block (9,550),
  unordered list (9,334), paragraph (7,220), indented code (4,857), and Markdown
  link (4,635). Refusals most often co-occurred with HTML tag (7,608), Markdown
  link (7,430), paragraph (7,322), wikilink (3,332), and inline code (3,259).
  The independently reformatted aggregate is byte-identical to the original
  (SHA-256 `30a9898e95b50551abb35ca10a7b9d5682ce326280beba568603361d59302104`).
- **Causal attribution rerun:** `c8b6ca3c` replaces the co-occurrence-only
  labels with one causal owner per edit and passed 63 focused tests (four
  corpus tests opt in separately), formatting, lint, type checking, and
  `just build`. Its first four-shard attempt reached roughly 21,000 assigned
  notes before all workers hit the harness's inherited 7,200,000 ms ceiling;
  the empty partials contain no candidate result and are excluded. Revision
  `1d44906d` adds a fingerprinted `censusTimeoutMs` that the merger verifies
  and restarted all four shards from note zero with a 12-hour ceiling under
  `/tmp/futo-causal-full-v3.u3CPoq`. The clean v3 run reached emitted
  checkpoints totaling 18,000 assigned notes / 130,463 edits
  (4k/4k/5k/5k) with no reported errors before it was stopped on 2026-08-25.
  The shard outputs are intentionally empty until completion, so there is no
  partial candidate result, causal rate, or merge. A future causal result must
  restart all shards from note zero, close the strict aggregate, and match every
  non-attribution counter in the original census exactly.
- **CM6 parse/render census:** 30,995 parses, zero parse exceptions and zero
  syntax-tree coverage mismatches. A bounded jsdom renderer logged 13
  `RangeError`s in 30,970 attempts; the Chromium sweep is the discriminator.
- **Visual sample:** `poc/corpus-visual-census` at `0ae475f2` stratified 24
  notes. Sixteen were manually reviewable without exposing corpus text: nine
  had observable CM6/Obsidian parity misses, four were capture noise, and three
  put the changed region outside the common crop. This is a presentation
  comparison, not a claim that Obsidian defines Markdown correctness.
- **Corpus-wide CM6 render census:** `poc/corpus-visual-census` at `3b05fe81`
  streamed all 30,995 notes through the real Chromium-hosted current-CM6
  live-preview driver. Four shards each saw all 30,995 records, reached uncapped
  EOF, and selected/completed exactly 7,749/7,749/7,749/7,748 notes. The strict
  merge therefore closed 30,995 selected = 30,995 completed = 30,995 classified:
  15,107 confirmed structural mis-renders (48.740119%), 376 render errors
  (1.213099%; all exact-source identity mismatches), zero input errors, and
  15,512 residual-human notes (50.046782%). There were zero incomplete parses,
  missing content DOMs, invalid decoration ranges, or runtime exceptions.
- **CM6 render oracle boundary:** only absolute product invariant failures or
  invalid live-DOM/source mappings enter the confirmed count. The 15,107
  confirmed notes are therefore a 48.740119% **lower bound**, not the total
  mis-render rate; 15,512 notes remain deliberately unclassified for human
  review. Confirmed notes produced 15,767 invariant occurrences: 14,453
  `list-line-hanging-indent`, 1,179 `cursor-reveal-does-not-shift-content`, and
  135 `no-quote-marker-bleeds-through`. Successful pipeline completion cannot
  prove semantic visual correctness, so every other successful note remains
  `residualHuman`. Exhaustive screenshots were deliberately not run: all 30,995
  observations record `screenshotNotRun`, with zero pixel-drift, size-crop, or
  offscreen candidates; none can inflate the confirmed count.
- **CM6 render strictness/performance:** all shards shared corpus SHA-256
  `1edbcf888da2d3fe633cf10c838cd811d14bf8957dda3d0f4ae3aaa2a21adc32`,
  config fingerprint
  `ca5113accbcd238a80296e36c918a5ee88d1a0e0514175548bad8bc70c9b9621`,
  candidate `3b05fe81`, and adapter fingerprint
  `182c73fb118d25b859c58bd59041d057a101e9f1a45a268d48c1229456459640`.
  The deterministic aggregate SHA-256 is
  `5d6c38269dedc9a440b37c80cc291d650433e6fa67c676800cff6dfd51b2e437`;
  a second strict merge reproduced it byte-for-byte. Slowest-shard wall was
  806,353.512 ms, summed Node CPU was 157,455.781 ms, and maximum measured Node
  RSS was 199,112 KiB; Chromium child-process memory is explicitly not claimed.
- **CM6 render verification:** the public-seam driver, classifier, streaming,
  privacy, and merger suites passed 13/13; targeted ESLint and `pnpm run build`
  passed; a 100-record real-Chromium discriminator and both strict full merges
  passed. `just check` reached `check:agent-docs` and then stopped on the
  pre-existing nonexistent `factory/holdout/` reference, recorded as papercut
  `pc_4051c8ffcf54`. Reports are aggregate-only and remain local/ignored.
- **Verification:** the 49-test TipTap suite (four opt-in corpus tests skipped),
  strict four-shard aggregation, formatting/lint, and `just build` passed.
  Full wall time was 3,042 seconds; peak measured RSS was 1,443,635,200 bytes.
- **Decision:** tree-owned approaches are repriced sharply downward. P4 still
  runs because it promises source patches rather than serialization; P3 remains
  conditional on P4 dying, as sequenced above. Recorded by Codex from the
  fixed harness criteria.

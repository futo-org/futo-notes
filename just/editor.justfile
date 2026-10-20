# Editor benchmarks, the editor gauntlet, and the Milkdown round-trip census. Imported by the root justfile.

# Block-drag cost per phase (lift, drop-spot change, drop, scroll frame) on
# 1000- and 3000-block notes, in the system WebKitGTK the desktop app ships.
# About 10s per variant; a variant is `current`, a copy of blockDragSession.ts,
# and either with `:line` for the drop-line mode. Opens a window per variant.
#   just bench-block-drag                              # current:line vs current
#   just bench-block-drag current /path/to/other.ts --repeat 3
bench-block-drag *args:
  node scripts/perf/block-drag-bench.mjs {{args}}

# Editor hill-climb score: elements restyled, layout scope and JS calls for eight
# editor interactions (typing, opening, block drag) in headless Chromium — counts, not timings.
# ~9.7s with the bundle build, ~4.9s with --no-build; --why <scenario> names causes. See docs/perf/editor-bench.md.
#   just bench-editor --runs 0 --baseline docs/perf/editor-bench-baseline.json
bench-editor *args:
  node --experimental-strip-types scripts/perf/editor-bench.mjs {{args}}

# ACCEPT/REJECT a change against the editor bench baseline: 3 count passes, no
# count worse, score ≥0.5 % better, then the editor-embed suite. Exits 1 on REJECT.
# The protocol for an agent climbing it: docs/perf/editor-bench-climb.md.
#   just bench-climb-gate            # verdict only
#   just bench-climb-gate --accept   # and write the new baseline
bench-climb-gate *args:
  node --experimental-strip-types scripts/perf/editor-bench-gate.mjs {{args}}

# Prove a chunked parse equals a whole-document parse over a real corpus; see justfile-notes.md.
chunk-census *args:
  node scripts/milkdown-chunk-census.mjs {{args}}

# ── Editor gauntlet (the permanent editor regression suite) ──
# The matrix and oracles live behind EditorGauntletAdapter, with one adapter
# per editor. `gauntlet-milkdown*` drives the SAME single-file editor.html the
# native shells ship (it builds the bundle first).
# Reports land in tests/editor-gauntlet/local/ (gitignored). Full details,
# including corpus sharding: tests/editor-gauntlet/README.md.

# The 56-case split-torture matrix against Milkdown, scored against the ledger.
gauntlet-milkdown:
  pnpm run test:editor-gauntlet:milkdown

# Milkdown performance floor: hard budgets at real-note sizes, no cliff above.
gauntlet-milkdown-perf:
  pnpm run test:editor-gauntlet:milkdown:perf

# Read ~/Developer/futo-notes-ml/NOTICE.md first, then point it at a corpus:
#   EDITOR_GAUNTLET_CORPUS=~/Developer/futo-notes-ml/dataset/sample.jsonl \
#     EDITOR_GAUNTLET_CORPUS_LIMIT=100 just gauntlet-milkdown-foreign
# Milkdown foreign-corpus sweep (never-refuse/never-warn/never-lose).
gauntlet-milkdown-foreign *args:
  pnpm run test:editor-gauntlet:milkdown:foreign {{args}}

# ── Milkdown round-trip census ──
# Run a corpus of real notes through the real Milkdown editor and report what
# the round trip changed. This is the measurement behind the compat plugin set
# in packages/editor/src/milkdown-compat/ (docs/plan/milkdown-transition.md §3)
# and the editor's own serializer (#266; the default `compat` variant writes
# with it), and the way to prove a change to either costs nothing:
#
#   just milkdown-census --variant baseline          # the UNPATCHED upstream preset
#   just milkdown-census --diff build/milkdown-census/baseline
#   just milkdown-census --vault ~/Documents/futo-notes   # your own notes, locally
#   just milkdown-census --limit 200                 # quick smoke, ~4s
#
# ~30k notes in about 3 minutes on 12 pages. Output lands in
# build/milkdown-census/<variant>/ (gitignored) — results.jsonl carries the
# round-tripped text of FLAGGED notes, so a vault run's output is your notes:
# read it locally, never commit it. `--diff` exits non-zero on any newly raised
# flag. Corpus default: ~/Developer/futo-notes-ml/dataset/notes_corpus.jsonl.gz.
# Findings write-up: docs/editor/milkdown-roundtrip-census.md.
milkdown-census *args:
  node tests/milkdown-census/run.mjs {{args}}

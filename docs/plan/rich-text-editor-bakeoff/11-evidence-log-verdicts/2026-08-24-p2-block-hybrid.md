### 2026-08-24 — P2 block hybrid — iterate

- **Revision:** `poc/editor-block-hybrid` at `38b8be89`. This includes the P1
  compiler via conflict-free cherry-pick `5f85e264`, the real-Tauri handoff at
  `3c6616bc`, strict performance/foreign-evidence identity, the candidate-specific
  gauntlet/factory adapters at `92ccdd9c`/`6d61a255`, and the single bounded
  active-block render iterate at `d054efeb`, the first exhaustive-run recovery
  guard at `8ac0dd7d`, the CRLF source-offset fix at `875707d0`, and bounded
  active-window materialization at `86bf6d85`, measured virtual geometry at
  `d80053be`, and bounded, topology-safe transitions at current HEAD.
- **Contract shape:** one exact source string and Lezer block map own the note;
  one CM6 instance owns only the active block. Common inactive blocks are pure
  projections; exotic/raw-HTML blocks are quiet, editable source islands.
  Composition defers remapping until `compositionend`.
- **Seam result:** repeated 100-crossing runs stayed below one frame; the
  slowest observed run was 5.6 ms p95 and 12.6 ms max, with zero measured
  layout shift and exactly one contenteditable.
  Synthetic composition created a new block boundary and remapped to the right
  exact-source block without a warning.
- **Performance:** at pre-render revision `4650f2e8`, the shared
  1k/10k/50k/10 MB fixtures opened in
  58.9/120.1/254.4/738.9 ms. Synchronous keystroke p95 was
  1.2/1.1/1.7/6.9 ms. All remain inside the fixed budgets.
  Two later 10 MB reruns under an unrelated Kotlin language server consuming
  roughly 20 of 32 cores reproduced 1.683/1.692 s and are retained as
  noisy-host failures, not substituted for the clean result. The second used
  a fixed eight-core affinity while the unpinned first did not, ruling out the
  affinity as the cause. No threshold changed. A current-revision repeat is not
  a remaining qualification gate because P2 was killed by the fixed second
  caret-crossing strike.
- **Selection:** `tests/editor-gauntlet/P2_SELECTION_DESIGN.md` defines global
  UTF-16 source selections, exact copy/delete, pointer capture, virtualization,
  Shift+Arrow, and composition arbitration; model tests prove segmentation.
  Real pointer-drag/auto-scroll remains production work.
- **Intent integration:** the shared P1 filter turns the bold-split story into
  `**bold**\n\n**words**`; a generic source-owner remount keeps one editor after
  the block split, and one undo restores the original bytes. No P2 delimiter or
  construct rule was added.
- **Candidate-specific full matrix:** the first immutable adapter run at
  `6d61a255` failed 56/56 because the active CM6 mounted raw Markdown syntax
  highlighting rather than the established live-preview projection. That was
  a named bounded omission, so the one permitted iterate installed the existing
  `liveMarkdownTransform` and made both gauntlet and factory read the actual
  candidate DOM. The exact rerun at `d054efeb` passed 32/56 and failed 24/56.
  Residue is all seven cross-block Backspace joins; Enter, Backspace, and paste
  for strike/wikilink/Markdown-link outside P1's bounded intent family; and the
  two strike marker-edge presentation cases. Save-payload/persistence and undo
  assertions did not fail. No second matrix fix was attempted. A detached exact
  current-revision rerun at `d80053be` remained 32/56 with the same 24
  semantic/render failures and zero undo failures. Its content-free artifact is
  ignored
  `tests/editor-gauntlet/local/p2-split-matrix-d80053be4d8b.json`, SHA-256
  `db7c479dacd1e566e2a9c570fbf5645210fa8b19bfb41a2afe3d4643cff247a5`.
  The exact `38b8be89` rerun also passed 32/56 and failed the same 24 cases,
  with zero skipped/flaky cases and zero undo failures; its canonical
  `{id, ok, failureKinds}` vector is byte-identical to `d80053be`. The current
  content-free artifact is ignored
  `tests/editor-gauntlet/local/p2-split-matrix-38b8be893081.json`, SHA-256
  `d90713549409e247745cf5e68c9dc729e932fc64f38930de95bdb92acb30d0bf`.
- **Exhaustive-run recovery:** revision `8ac0dd7d` handled the known exception
  from activating a block beyond the prototype's leading 250-block viewport,
  but the first full run disproved the assumption that this was the only poison
  path. Four completed shards failed 6,836/7,437, 7,098/7,820, 7,377/8,078, and
  6,435/7,356 edits, respectively, after one caret-walk failure in each. A
  content-free 4.7-second replay minimized the first failure to CM6 throwing
  `Selection points outside of document`: the source-owned model retained raw
  UTF-16 offsets while CM6 auto-normalized a two-code-unit CRLF to one document
  position. The exception also left the render re-entrancy guard latched, so
  every later note lost its active editor. The four reports are preserved but
  excluded from candidate rates under ignored
  `tests/editor-gauntlet/local/p2-foreign-8ac0dd7d/`.
- **Corrected candidate:** `875707d0` makes CM6 treat only LF as its line separator,
  retaining CR as an exact source code unit even in mixed-ending blocks, and
  releases the render guard in `finally` on every error path. The four-character
  `a\r\nb` regression failed before the fix and passed after it; the original
  two-note corpus replay then completed 12/12 edits. A preflight then identified
  the separately known hard cap: blocks after index 249 could not satisfy the
  strict every-planned-edit invariant. Rather than run a known-incomplete
  census, `86bf6d85` centers a bounded 250-block DOM window on the active source
  block and retains height placeholders on both sides. Its regression failed
  first on block 251, then proved the real exhaustive adapter could select,
  edit, save, and preserve exact source there. The focused browser suite passed
  10/10, model/adapter tests 7/7, and TypeScript, ESLint, Prettier, and
  `just build` passed. Read-only review then caught an 8px geometry regression:
  recentering at block 125→126 replaced a measured 35px paragraph with a fixed
  27px spacer. `d80053be` keeps the mounted window stable through ordinary
  crossings and uses measured hidden-block heights when the window edge moves.
  Its regression failed first at 8px, then measured 0px at both 125→126 and the
  actual 249→250 virtual-window edge. A subsequent read-only audit proved that
  the edge still rebuilt and measured all 250 projections in 38–63 ms and found
  stale cross-note/suffix heights, pointer remounts, deferred-topology drift,
  composition ownership, and remount-undo failures. `38b8be89` slides one
  entering/leaving block, applies deferred offsets lazily, locally confirms
  risky prefix edits before any remount, invalidates numeric caches on real
  topology changes, and preserves live-CM caret/undo state across structural
  and composition transactions. The final adversarial audit reported no
  remaining in-scope finding. Its 21 Chromium tests passed: the virtual edge
  measured 3.6 ms, the edited 5,001-block edge 4.0 ms, pointer activation
  3.8 ms, and 100 ordinary crossings 5.5 ms p95 / 7.9 ms max with zero shift.
  Eleven model/adapter tests, targeted lint/format/diff checks, and `just build`
  also passed. A private standard-shape remeasure recorded 10k-line sync/settled
  p95 at 3.0/17.5 ms and 50k at 4.3/20.2 ms; the tracked P2 performance test now
  rejects gross settled-to-paint jank as well as synchronous overruns.
  A 500 KB unbroken-paragraph diagnostic remained about 49.8 ms because the one
  active CM6/live-Markdown block is itself unbounded; that non-standard shape is
  recorded as a prototype limitation, not substituted for or added to the
  declared 1k/10k/50k-line plus 10 MB contract. A fresh strict 64-shard
  full-corpus run was started at current revision under ignored
  `tests/editor-gauntlet/local/p2-foreign-38b8be89/`, then stopped on 2026-08-25
  before any shard report completed. Its logs are retained but excluded; no
  aggregate or candidate rate exists.
- **Candidate-specific feel oracle:** the final `d054efeb` factory round
  completed 266/266 comparisons without a driver error: 41 matched and 225
  diverged (15.4135% match). Its aggregate SHA-256 is
  `afbe9830fadf9543ea0c1caa5a374174ae1d9e771eea6f7c338ea17a0836cf83`;
  buckets are 323 Obsidian-only decorations, 215 FUTO-only decorations, ten
  visible-text drifts, eight cursor drifts, eight selection drifts, and four
  document mismatches. As designed, this is a human-read comparison rather
  than an automated feel verdict. This artifact predates the later transition
  repairs, but P2's fixed second-strike kill means a post-verdict rerun cannot
  affect qualification and is not a remaining gate.
- **Candidate-specific evidence commands:** the matrix used
  `EDITOR_GAUNTLET_ADAPTER=p2-block-hybrid EDITOR_GAUNTLET_CANDIDATE=p2-block-hybrid EDITOR_GAUNTLET_ARTIFACT_CAPTURE=off-retry-on-failure pnpm run test:editor-gauntlet:cm6`;
  the exact current-revision artifact added
  `CHOKIDAR_USEPOLLING=1 CHOKIDAR_INTERVAL=2000 FUTO_DEV_PORT=6757 PW_RUN_ID=p2-matrix-d80053be-poll` to that environment;
  the `38b8be89` rerun used the same polling/candidate environment with
  `FUTO_DEV_PORT=6758 PW_RUN_ID=p2-matrix-38b8be89-poll`;
  the oracle used
  `FACTORY_CANDIDATE_PATH=/p2-block-hybrid.html FACTORY_CANDIDATE_READY_SELECTOR=#probe just factory-judge`.
  The content-free matrix log is retained under ignored
  `tests/editor-gauntlet/local/p2-full-d054efeb/`; the oracle aggregate is
  ignored `factory/captures/last-run.json`. No screenshot was needed to decide
  either mechanical result.
- **Real WebView smoke:** the isolated launcher was exercised in the actual
  Fedora Tauri WebKitGTK surface through the webview bridge. Common bold, list,
  and table projections rendered with one CM6 instance; a CRLF note containing
  raw HTML stayed byte-exact with a quiet source island; Enter split the fixed
  bold story and one undo restored it exactly. A synthetic composition commit
  produced `alpha\n\n日本\n\nbeta`, remapped to the new middle block, retained
  one editor, and emitted no warning. Console capture contained no application
  error. This smoke also predates the post-verdict transition repairs and lacks
  a durable exact-command ledger; it is retained only as historical
  characterization, not qualification evidence.
- **Verification:** nine unit tests, five Chromium seam/story tests, the shared
  performance test, lint/formatting, and `just build` passed. The final handoff
  revision reran the four owning model tests and five Chromium tests (100 seam
  crossings: 2.6 ms p95, 3.1 ms max, zero layout shift), plus script syntax,
  targeted ESLint/Prettier, recipe discovery, and the real WebView smoke above.
  At candidate revision `38b8be89`, eleven focused model/adapter tests and 21
  Chromium seam/story/driver tests pass; targeted ESLint, Prettier,
  `git diff --check`, and `just build` pass.
  The once-planned current-revision three-run browser discriminator is no
  longer a decision gate after the fixed second strike.
- **Verdict:** **kill**, recorded by Codex. `86bf6d85` first fired the
  predeclared caret-crossing condition by shifting layout 8 px at the virtual
  edge. The permitted iterate, `d80053be`, removed that shift but fired the
  same composite condition again by rebuilding 250 projections in 38–63 ms,
  beyond one frame. The fixed two-strikes rule therefore killed P2 at
  `d80053be`; the later `38b8be89` work is useful post-verdict characterization
  but cannot resurrect the candidate. Physical IME and P1-vs-P2 feel are no
  longer gates because only P1 survives.

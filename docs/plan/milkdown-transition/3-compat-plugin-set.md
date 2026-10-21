## 3. Compat plugin set (replaces the parked string guards)

Home: `packages/editor/src/milkdown-compat/` (exact name at implementation time). Both hosts and
the corpus harness consume the same module — the ADR-0002 "one serializer" rule extends to these.

1. **`<br>` fix — replace, don't wrap**: filter `remarkPreserveEmptyLinePlugin` out of the
   commonmark preset and `.use()` a fixed local copy that deletes the empty-paragraph `<br />`
   placeholder only when it is the sole child of its paragraph. Kills the protect/restore marker
   dance and both known string-guard regressions (footnote definition idx 8560, table-in-blockquote
   idx 25957) by construction — the mdast tree knows its paragraph context.
2. **Empty-link fix**: remark transformer that gives `link` nodes with zero children a text child
   equal to the URL. One-way. Images are a different mdast node type, so the `![](url)` regression
   class from the regex version cannot occur.
3. **ATX-escape narrowing** (added by T5, #102 — `milkdown-compat/atxEscape.ts`): remark-stringify
   escapes EVERY line-leading `#`, so a note's header tag block `#alpha #beta` saved as
   `\#alpha #beta` and the tag stopped being a tag to `scanTags`, `extractHeaderTagBlock`, the tag
   bar, and Obsidian. Replaces the blanket `{atBreak: true, character: '#'}` unsafe rule with the
   real CommonMark condition (1-6 `#` then space/tab/EOL) by wrapping Milkdown's own `text`
   handler — an extension can only ADD unsafe patterns, but handlers can be replaced.
4. **Bullet-number escape**: the pre-parse string pass stays (`* 0. item` → `* 0\. item`) — remark
   transformers run post-parse, after CommonMark has already resolved the ambiguity into a nested
   list. Same skip-fences/inline-code rules as the parked WIP.
5. **Canary tests**: pin the Milkdown version; a test reproduces each upstream bug against the
   *unpatched* preset so the day upstream fixes it the canary flips and the fork gets deleted.
   Register the fork in `scripts/drift-registry.json` if `check-drift` flags it.
6. **Upstream**: file the `<br>`-deletion and empty-link bugs against Milkdown with the minimal
   repros from the census report.
7. **M6 carve-out**: these transforms are Milkdown-implementation adapters, not note rules — no
   Rust mirror. Record the carve-out in `packages/editor/AGENTS.md` when the module lands.
8. **Re-census** after the rewrite: full foreign corpus + a second leg over Justin's real vault
   (local, never committed). Diff against `corpus-results-baseline.jsonl` (regenerated baseline on
   the spike). Target: the two real-loss classes at zero, zero new regressions, the 16
   uninvestigated `html_loss` notes dispositioned. Per D4 this is tracked, not gating — but the
   report is a required deliverable (`docs/editor/milkdown-roundtrip-census.md` or a `tests/`
   local artifact).

### T2 outcome (#99, done)

Landed as `packages/editor/src/milkdown-compat/` — `commonmarkWithCompat`, one
array that replaces `.use(commonmark)`. Numbers and the full write-up:
`docs/editor/milkdown-roundtrip-census.md`. Over 30,995 corpus notes,
`<br>` deletion **61 → 0**, empty-link deletion **26 → 0**, `html_loss`
**61 → 0**, and **zero newly-raised flags** per note; the maintainer's own
2,511-note vault agrees (run locally, results not committed).

What changed against §3 as written:

- **All three `<br>` isolation cases collapsed into one rule.** The parked
  string guards needed separate handling for bare paragraphs, table cells and
  list items, and still could not see a table nested in a blockquote or a
  footnote definition. In the mdast tree the placeholder is simply "in block
  position, or the sole child of a paragraph/table cell", and both parked
  regressions (idx 8560, 25957) cannot occur.
- **The fork keeps upstream's slice id**, `remark-preserve-empty-line`.
  `node/paragraph.ts` only emits the placeholder when
  `ctx.get('remark-preserve-empty-line')` resolves, and `Ctx#get` looks a string
  up by slice *name* — registering under a new name would have silently turned
  the serializer half off and started dropping blank lines the author typed.
  **Reversed 2026-09-03:** the placeholder itself is now gone. A `<br />` line
  showed up in a real note after two Enters, and the author does not want HTML
  in their files. The fork registers under its own name (so the paragraph
  serializer never emits the tag), restores `N` blank lines as `N - 1` empty
  paragraphs from mdast positions on load, and a `join` rule writes an empty
  paragraph back as one extra blank line — the encoding the CodeMirror editor
  always produced. Legacy tags still load as the paragraph they stood for.
  Progressive open counts the blank run at each chunk seam so the chunked
  document equals the whole one (`seamEmptyParagraphs`). Census and chunk-census
  numbers: docs/editor/milkdown-roundtrip-census.md.
- **One extra repair was needed.** remark will not write an eol directly before
  inline HTML (mdast-util-to-markdown#15), so a preserved `<br>` after a hard
  break stranded the break's backslash mid-line. A kept tag is moved in front of
  the breaks it follows; without that, six notes regressed.
- **The bullet-number escape is a partial fix, by design of the scope.** 342 →
  299. The 299 are the same placeholder mechanism reached through `* > quote` /
  `* * nested` (279), where escaping would change meaning, plus 16 digit-dot
  bullets indented past the escape's CommonMark 0–3-space allowance. The report
  names the follow-up: drop the structurally-required empty leading paragraph in
  a `listItem`. **Not done here** — it is a different fix to a different cause.
- **The census is a recipe now**, `just milkdown-census`, with a `baseline`
  variant that runs the unpatched preset. That is how "did anything regress" is
  answered from the harness itself rather than from numbers nobody can
  re-derive, and it is how the canary tests reproduce the upstream bugs.
- The two upstream bugs are **drafted, not filed** —
  `docs/editor/upstream-milkdown-issues.md` waits on Justin, since filing posts
  publicly under the project's name.
- **No `docs/spec/` change** (M19). Milkdown is not the shipping editor yet, so
  the existing spec lines stay in force until the swap (bucket 2, D9); nothing in
  this work changes CM6's behavior.

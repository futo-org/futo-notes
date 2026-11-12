# Linedown in the text-first engine — implementation plan

Tracks #423. The dialect is `docs/spec/editor/portable-core/linedown.md`. Delete this file in the
commit that finishes step 3 (archive rule).

## Decisions (final, maintainer 2026-11-12)

- The engine reads and writes Linedown only. No setting, build flag or CommonMark mode.
- A new line reader replaces pulldown-cmark inside `crates/futo-notes-editor`; `vendor/pulldown-cmark`
  is deleted. The session, host and FFI surface keep their shape unless the rewrite shows one is in
  the way, in which case say so on #423 and rewrite further. Any module may be rewritten from
  scratch instead of patched.
- One long-lived branch, `linedown`, holds the spec, this plan and all three steps. Main receives
  it once, whole. Main is never half CommonMark and half Linedown.
- Tests that pin CommonMark behavior are rewritten to the Linedown result or deleted. They are a
  requested change, not regressions.
- The engine never writes an HTML entity into a note. The writer uses `\` escapes only.
- The writer adds no escape because of what is typed (`- ` makes a bullet, `# ` a heading). It
  writes a `\` only when a command would otherwise change a line's meaning by accident (removing
  the bullet from `- # todo` writes `\# todo`).
- Reading never renumbers. Editing does: Enter in a numbered item writes the next number, and
  items below that were counting up in sequence are bumped to stay in sequence. Items that were
  not in sequence (`1.` `1.` `1.`) are left alone.
- Commands keep the behavior a user sees today wherever it still means something. Each behavior
  Linedown makes meaningless is listed under "Command behavior that changes" for review.
- Numbers show as typed: the engine hands renderers the marker's text, and iOS draws it.
  Android's renderer is on `android-text-first` and picks the field up there.
- Milkdown is not changed. It leaves in the same release that brings this editor to desktop, so
  the two editors disagreeing about a note is not a shipped state.
- Code does not name the dialect. Only the spec and the fixture file say "Linedown".
- No speed work beyond the bar: no counted-work budget in the tests goes up.
- Files are never rewritten to fit the dialect.

## Step 1 — the line reader, alone

A new module `src/linedown/` that nothing else calls yet.

- **Block reader.** One pass over lines with a small carry: open fence (character and length),
  open front matter, the list stack (indent widths of the list lines above, tab = 4), and "inside
  a table". Output per line: block kind, quote depth, list marker text, list depth, task state,
  heading level, the ranges of the marker and the content, fence role, table role. Offsets are
  document-absolute.
- **Table header.** The single reach-back: when a line is a delimiter row and the line above is a
  `|` line at the top level, the reader reports the line above as a header. An incremental update
  therefore re-reads at most one line above the edit.
- **Inline reader.** One line in, spans out: bold, italic, strikethrough, inline code, link,
  bare URL, `<url>`, image, wikilink, tag, backslash escape. CommonMark's delimiter rules for
  `*`, `_` and `~`, applied to one line. Wikilinks and tags keep using `futo-notes-wikilinks` and
  `futo-notes-tags`.
- **Incremental update.** Given an edit, re-read from the first changed line until the carry at a
  line's end equals the carry it had before. Worst case is the rest of the note (a fence or front
  matter opened or closed), which is also true today.
- **Fixture file** `tests/fixtures/linedown.json`: input text and, per line, the expected block,
  depth and inline spans. At least one case per rule in the spec and one per row of its
  "Differences from CommonMark and GFM" table. The crate's tests run it.
- **Comparison run.** A test-only binary reads every `.md` under a directory with pulldown-cmark
  and with the new reader and prints each class of line whose reading changed, with counts. Run
  read-only over `~/Documents/futo-notes` and `../futo-notes-ml`. Any class the spec does not
  predict is a bug. pulldown-cmark stays in the tree until step 2 only so this run can happen.

Done when the fixtures pass, the comparison shows only predicted classes, and the numbers are
posted on #423.

## Step 2 — the swap

- **Parse sites.** The twelve places that build a pulldown `Parser` move to the line reader:
  `inline/row/parse.rs`, `inline/blocks.rs`, `inline/lists.rs`, `inline/fences.rs`,
  `inline/blocks_paragraph.rs`, `inline/row.rs` (`scan_open`, `reaches_into`), `inline/row/split*`,
  `inline/references*`, `inline/links/bare.rs`, `inline/kept.rs`, `quick_open.rs`,
  `session/blocks/content.rs` (`protect_content`), `session/images.rs`.
- **Types.** `HeadingSyntax::Setext`, `BlockLine.underline` and `bodies`, `paragraph_text`,
  `html`, and the CommonMark columns and computed ordinal on `ListLine` go. A block is one line.
- **Rows.** A row becomes a line, or a run of lines with the same carry. The reparse window is
  "changed lines, then forward until the carry settles", plus one line back for a table header.
- **Writer.** Remove the entity writer (`literal_typing`, `spelling.rs` respelling, `&#32;` and
  `&#35;`, the boundary repairs that encode a neighbor as an entity) and the speculative typed
  escapes from !650. Keep one small function that decides whether a line's text needs a leading
  `\` to stay the block a command intends.
- **Commands**, rewritten against one-line blocks: list Enter, Enter at item start, indent and
  outdent, join and Backspace, heading and quote toggles, divider, split, paste. The
  respell-reparse-repair planner (`session/blocks/list_edit/`) is not ported: with one-line items
  a command edits the lines it names and nothing else changes meaning.
- **Host and FFI.** `StyleSpec::ListRow` gains the marker text as typed and drops the computed
  number. An indented plain line inside a list is reported with the depth of the list line it
  aligns to and no marker. `crates/futo-notes-ffi/src/editor/host.rs` mirrors both.
- **iOS** (`apps/ios/Sources/Editor/TextFirst/`): draw the marker text the engine sends
  (`TextFirstLayoutFragments.swift` draws `"\(number)."` today, so `3)` shows as `1.`); indent a
  markerless list-aligned line by its depth (`TextFirstStyler.swift`); blank lines show one per
  line. No Markdown rule is added to Swift.
- **Tests.** Rewrite or delete the tests that pin removed behavior, in the crate (717), the
  store's `editor_session` tests (104), the FFI editor tests (66) and the shared JSON list
  fixtures (224 cases, also run by `tests/wasm-*-consumer.mjs`). Counted-work budgets in
  `tests/long_regions*` and `tests/inline/work.rs` are measured before and after.
- **Spec.** Every `docs/spec/editor/portable-core/*.md` and `docs/spec/editor/mobile/*.md` line
  that states CommonMark behavior is rewritten or deleted in the commit that changes the behavior.
  `typed-escapes.md` is deleted. Milkdown's files (`markdown-house-style.md`,
  `markdown-elements.md`, `paragraphs-and-lines.md`) are not touched.
- **Delete** `vendor/pulldown-cmark` and its `[patch.crates-io]` entry.

Done when `just check` passes on the branch, the comparison run from step 1 still shows only
predicted classes through the real session, and the iOS debug build shows the spec's examples
correctly on a simulator.

## Step 3 — delete what became unreachable

- `inline/row/split/` and `split.rs` (seam sealing, word seams, list and quote cuts),
  `inline/window.rs` widening, `inline/kept.rs`, `inline/row/context.rs`, `inline/row/html.rs`.
- `inline/references*` and every reference-link, footnote, raw-HTML and entity path.
- `session/blocks/list_edit/` repair and verification, `apart_marker`, `quote_neighbor_separator`,
  `input_before_lazy_quote_neighbor`, the divider's `***` substitution.
- The "refused list shapes" that only existed because a respelling could fail.
- Dead tests and spec lines that described them.

Done when nothing in the crate mentions setext, lazy continuation, reference definitions,
footnotes or entities except as literal text in tests.

## Command behavior that changes

For review. Everything not listed keeps today's behavior.

| Today | Under Linedown |
|---|---|
| Enter in the middle of a multi-line item keeps the rest in the item | An item is one line. Enter splits it into two items. |
| Enter after a lazy line re-indents the lazy line | There are no lazy lines. Nothing is re-indented. |
| Exiting a list writes a blank line so the next line is not a continuation | No blank line is written. The marker is removed and the line is plain. |
| An empty bullet under text gets a blank line inserted above it | Nothing is inserted. |
| The divider command writes `***` under text | It writes `---`. |
| Two touching lists are kept apart by switching the second to `*` or `1)` | Markers are left as typed. Two runs of bullets are simply bullets. |
| Indent and outdent renumber the whole ordered list | Only items that were counting in sequence are bumped. |
| A lone `#` is saved as `&#35;` until the word continues | It is saved as `#`. It is a plain line. |
| Leading spaces on a plain line are saved behind `&#32;` | They are saved as typed and shown as typed. |
| A delimiter row typed under a pipe line with no outer pipes makes a table | It does not. A table row starts with a pipe. |
| Deleting a setext heading's text leaves an empty ATX heading | There are no setext headings. |
| A list command inside a lazy quote adds `> ` to the lazy line | Every quote line already has its `>`. |
| Some list shapes are refused (`- > b`, a content column inside a tab, a setext row) | Not refused. `- > b` is a bullet with the text `> b`. |

## Paused and open work

| Item | Call |
|---|---|
| !660 (#348), edits across a code block give wrong source | Redo on Linedown. Fence handling survives; the block walk under it does not. |
| !661 (#355), `InvalidRange` in paste and Enter shapes | Dead as written (list Enter and paste are rewritten). Its cases become fixtures. |
| #353, Backspace on a line an Enter split out of a link | Dead: a link cannot cross a line, so the shape cannot exist. Confirm with a fixture. |
| #414, Enter in a task item with a lone CR panics (`list_paragraph.rs:115`) | Dies with `list_paragraph.rs`. Becomes a fixture. |
| #421, #422, Enter around list items | Die with the list rewrite. Become fixtures. |
| #417, typing at the end of front matter without a trailing newline | Survives. Recheck after step 2. |
| #419, text in an extra table cell cannot be formatted | Changes: Linedown trims extra cells. See open question 2. |
| #420, formatting a table above ~300 rows is refused | Survives. Table staging is not part of this work. |
| `engine/no-comment-separator` | Merge to main first (it stops the engine writing HTML comments into notes), then rebase `linedown`. |
| `desktop/new-editor`, `desktop/gpui-rewrite`, `fix/text-first-list-renumber-and-tab` | Rebase onto `linedown` after step 2, or drop. Owner's call. |

## How existing notes read differently

Measured read-only on the maintainer's vault (2,645 notes, 85,192 lines) on 2026-11-12. Nothing
is rewritten; these are display differences.

| Pattern | Notes | Under Linedown |
|---|---|---|
| Plain line directly under a plain line | 739 | Shown as written |
| Two or more blank lines in a row | 347 | Shown as written |
| Trailing two-space hard break | 63 | Invisible trailing spaces |
| Tables | 62 | Unchanged if every row starts with a pipe (to be counted in step 1) |
| Indented line under a bullet | 22 | Its own line, drawn under the bullet's text |
| Unindented line under a bullet | 19 | Its own plain line |
| Bold left open on one line | 7 | Literal `**` |
| 4-space or tab indented code | 6 | Plain lines |
| Footnote definitions | 3 | Literal text |
| Setext headings | 2 | Plain line and divider (both were accidents) |
| Lazy quote lines | 1 | Not quoted |
| Reference-link definitions | 0 | — |

Step 1's comparison run replaces these grep estimates with the reader's own counts and adds
`../futo-notes-ml`.

## Open questions

1. **Line endings.** The spec does not say what a line break is. Proposed: `\n` and `\r\n` end a
   line; a lone `\r` is an ordinary character. The engine handles lone CR today (#414).
2. **Extra table cells.** The spec says a long row is trimmed. Is the extra text hidden,
   or shown unstyled after the last column? Hidden text cannot be edited, which is #419's
   complaint in a new form.
3. **Other readers.** `futo-notes-tags` matches inline code across line breaks and
   `futo-notes-search` scans `#` with no code skipping. Both can disagree with the editor about
   whether `#x` is a tag. Out of scope here; file separately once step 2 lands.
4. **Front matter.** Milkdown's spec and the engine today require a closing `---`. Linedown runs
   unclosed front matter to the end of the note. A note that opens with a divider line becomes
   all metadata; the renderer must make that state obvious.

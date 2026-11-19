# Desktop editor behavior ledger

Research date: **2026-11-10**. Checkout: **desktop/new-editor**, `396c7a29d2cbb72984adc4499b702b77ce267112`. GitLab inventory is frozen at **!640 / #409**. Later main and other-branch findings are evidence to integrate, not claims that this checkout implements them.

**315 behavior rows in 21 areas.** All 640 MR descriptions and discussion pages were retrieved; **345 MRs were read in full**, while 295 received title/description screening. Retrieval is not full review. All 32 fresh complaints and four additional maintainer decisions are mapped in [the intake](maintainer-intake.md).

“Applies” names the desktop delivery stage, not a passing result. `desktop now` includes engine behavior reachable through slices 1–2 even when its formatted display is deferred. “Check” distinguishes existing engine/spec coverage from desktop stories still owed. No builds, tests, apps or device QA were run.

Abbreviated `portable-core/`, `desktop/`, `cursor/` and other editor spec paths mean `docs/spec/editor/`; engine `tests/*.rs` means `crates/futo-notes-editor/`. An undated current-spec rule refers to this inspected snapshot. `path@sha^` means the version before deletion. Other-branch evidence names its branch.

## Areas and counts

| Area                                                                                  |    Rows |
| ------------------------------------------------------------------------------------- | ------: |
| [Caret and selection](caret-and-selection.md)                                         |      16 |
| [Pointer and touch](pointer-and-touch.md)                                             |      15 |
| [Typing, composition and input methods](typing-and-composition.md)                    |      16 |
| [Inline formats and format edges](inline-formats.md)                                  |      12 |
| [Headings](headings.md)                                                               |       9 |
| [Lists, tasks, quotes and dividers](lists-tasks-quotes.md)                            |      22 |
| [Code blocks](code-blocks.md)                                                         |      15 |
| [Links and wikilinks](links-and-wikilinks.md)                                         |      15 |
| [Images](images.md)                                                                   |      14 |
| [Tables](tables.md)                                                                   |      16 |
| [Paste, copy and drag](paste-copy-drag.md)                                            |      18 |
| [Undo and Redo](undo.md)                                                              |       8 |
| [Scrolling and viewport](scrolling-and-viewport.md)                                   |      14 |
| [Large notes and performance](large-notes-and-performance.md)                         |      20 |
| [Open, save, rename, reload and outside changes](open-save-rename-outside-changes.md) |      31 |
| [Toolbar and shortcuts](toolbar-and-shortcuts.md)                                     |      18 |
| [Find in note](find.md)                                                               |      10 |
| [Tags and front matter](tags-and-front-matter.md)                                     |       9 |
| [Markdown fidelity](markdown-fidelity.md)                                             |      15 |
| [Accessibility](accessibility.md)                                                     |       8 |
| [Platform quirks](platform-quirks.md)                                                 |      14 |
| **Total**                                                                             | **315** |

| Applies                 | Rows |
| ----------------------- | ---: |
| desktop now             |  104 |
| slice 3                 |   39 |
| slice 4                 |   38 |
| slice 5                 |   36 |
| slice 6                 |   22 |
| slice 7                 |   22 |
| slice 8                 |   10 |
| slice 9                 |   17 |
| slice 10                |    2 |
| later: progressive open |    6 |
| mobile only             |   15 |
| obsolete                |    4 |

Supporting records: [maintainer intake](maintainer-intake.md), [escaping writers](escaping-audit.md), [42 spot-checks](spot-checks.md), [50 complete current-spec reads](current-spec-review.md).

## The 20 highest-risk rows

1. [MD01](markdown-fidelity.md#md01) — Typed markers still gain hidden escapes despite Mason's explicit reversal.
2. [OS07](open-save-rename-outside-changes.md#os07) — Late outgoing text must never save under an incoming note's identity.
3. [OS08](open-save-rename-outside-changes.md#os08) — A failed or remounted editor must never become a valid empty note.
4. [TI02](typing-and-composition.md#ti02) — Stacked bold, italic and strike must never swallow typing.
5. [CS01](caret-and-selection.md#cs01) — Engine selection, native range and painted selection must agree.
6. [CS05](caret-and-selection.md#cs05) — Grapheme, surrogate, CRLF and source/display offsets must stay coherent.
7. [TI03](typing-and-composition.md#ti03) — Composition commits once with exact input order and coherent history.
8. [UN01](undo.md#un01) — Undo never crosses notes, including notes with identical bytes.
9. [MD02](markdown-fidelity.md#md02) — Opening and local edits preserve untouched author source.
10. [PF03](large-notes-and-performance.md#pf03) — Long quote typing must not reparse and repaint the whole container.
11. [PF04](large-notes-and-performance.md#pf04) — Toolbar presses cannot queue minutes of stale work or block leaving.
12. [CB07](code-blocks.md#cb07) — Select All → Code preserves every line, avoids a crash and Undoes once.
13. [OS13](open-save-rename-outside-changes.md#os13) — Outside adoption cannot overwrite dirty or composing local text.
14. [HG02](headings.md#hg02) — Heading-start Backspace joins upward without unexpected demotion.
15. [SV02](scrolling-and-viewport.md#sv02) — Note return restores scroll after the relevant layout exists.
16. [CS02](caret-and-selection.md#cs02) — A soft-wrap caret retains its visual-row association.
17. [TB05](tables.md#tb05) — Multiline plain and rich paste cannot overwrite the next cell.
18. [IM01](images.md#im01) — A final image has a reachable exit, as code must too.
19. [TS02](toolbar-and-shortcuts.md#ts02) — Active, disabled and toggle-off state describe the actual command.
20. [PF12](large-notes-and-performance.md#pf12) — Live DOM Ranges cannot make a click-then-large-open quadratic in WebKit.

## Open decisions

Eight decisions, with what each past editor did and a recommendation: [open-decisions.md](open-decisions.md).

## Coverage and limits

- **GitLab:** 640 MRs, every state: 489 merged, 112 closed, 39 open in the initial inventory. All descriptions and discussion pages retrieved read-only. A second census confirms **248 non-system notes**, no request errors, second pages only for !558/!564. **345 complete description/discussion reads; 295 title/description screenings**, mostly CI, tooling, releases and unrelated features. Some screened descriptions were searched/excerpted rather than fully read. !641/!642 appeared during research and are outside the frozen inventory.
- **Issues/work items:** 403 entries through #409, descriptions and 76 non-system notes retrieved. Targeted editor narratives inspected; no independent GraphQL-only work-item census.
- **Git:** all-ref history reaches **9,046 commits since 2025-11-14** (5,040 reachable from this HEAD; all-ref count includes 357 T3 checkpoints). Broad path/subject searches and selected complete bodies/diffs were read, not all bodies. Cited SHAs were checked for resolution/ancestry; unavailable MR-reported 173f77705 was replaced with !370. Other-branch findings name their branch.
- **Deleted docs:** deletions enumerated; December/later Markdown specs, scroll/IME learnings, strategy/parity/bakeoff and ownership plans inspected. Some large archived files were excerpted; not every editor.md version or native submodule implementation was read.
- **Current docs/tests:** all **50 editor specs** (330,645 bytes), editor.md, relevant AGENTS/platform traps and learning/research/QA material. P0/P1/P2 read in full; embed, conformance and engine names/comments plus selected bodies inspected. Not every test body was read.
- **Validation:** 42 recorded source spot-checks, additional tuning checks, and structural count/link/row/byte checks. No runtime behavior was executed.
- **Excluded as requested:** Zulip, crashlog/feedback store, app driving, builds, cargo/package managers, tests, puppet, checkout/stash/commits and remote mutations. Feedback identifiers came from GitLab or git.
- **Confidence:** high in cited decisions, moderate in breadth; **not a guarantee of exhaustive coverage**. Weakest: early native/submodules, niche input methods and assistive technology, exact external-app heading/export matrices, and decisions hidden in unrelated diffs. No platform or latency claim was freshly verified.

# Open decisions and resolved conflicts

Row links are relative to this folder. See [the index](README.md).

### H. Inline formats inside headings

**Recommendation: allow bold, italic, strikethrough and inline code in every heading.** Mason already chose bold/italic/strike on 2026-11-04: decision 1A in `docs/plan/text-first-mason-feedback-2026-11.md@055240f3b` on `android-text-first`. Current markdown-elements.md explicitly permits heading emphasis and code. Code spans remain opaque; this does not mean parsing emphasis inside code.

CommonMark parses heading contents as inline content, allowing strong/emphasis/code. Strikethrough is a GFM inline extension. Both therefore support heading inlines; CommonMark alone does not specify strike. [CommonMark heading rule](https://spec.commonmark.org/0.31.2/#atx-headings), [GFM](https://github.github.com/gfm/).

| FUTO editor                 | Display and saved-source evidence                                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Early native / December CM6 | 74cf4ba12 and f826484eb document headings and inline decoration. January c8e6e19d2 reduced native Markdown scope. A complete heading × four-format × saved-byte matrix is **unverified**, especially submodule internals.      |
| Later CM6                   | !16 decorates heading and inline syntax independently; source is the document. Deleted `docs/markdown-spec.md@2ac045dd6^` records the rules. Source preservation does not prove every glyph/style combination.                 |
| Milkdown                    | markdown-elements.md promises heading inlines. The house writer emits ATX, asterisk emphasis, tilde strike and backtick code, normalizing the note on first edit. No runtime heading matrix was run.                           |
| Current engine              | host_style_plan.rs::headings_inline_formats_and_lists_are_planned_in_utf16 asserts heading plus bold; interpretation supplies independent inline runs and retains source. Other rendering combinations were not executed here. |
| Android text-first          | Feedback A1 identifies TfHeading.apply replacing the emphasis typeface with semibold; strike survives as a paint flag. This explains appearance, not every rejected toolbar command.                                           |
| New desktop                 | lineElements.ts::drawLine draws heading classes and one text node today; inline spans are slice 3. Missing styling is not an intentional ban.                                                                                  |

External evidence checked 2026-11-10, without driving an app:

| App         | What is established                                                                                                                                                                                                                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Obsidian    | Official typography explicitly shows `## Bold **bolder**` and additive bold weight. Other heading combinations and exported bytes remain **unverified**. [Typography](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Reference/CSS%20variables/Foundations/Typography.md).                                                  |
| Bear        | Explicitly supports multiple styles in headings; its guide lists all four. Exact combinations and export bytes remain **unverified**. [Markdown guide](https://bear.app/faq/how-to-use-markdown-in-bear/).                                                                                                                                      |
| iA Writer   | Documents h1–h6 and all four inline formats. Heading-specific editor/preview behavior and bytes remain **unverified**. [Markdown guide](https://ia.net/writer/support/basics/markdown-guide?platform=windows).                                                                                                                                  |
| Apple Notes | Documents paragraph/character styles and Markdown import/export. All four heading combinations, monospace versus code, and export spelling remain **unverified**. [Formatting](https://support.apple.com/en-mide/guide/notes/apd1955d3b21/mac), [export](https://support.apple.com/guide/notes/import-export-and-print-notes-not201900c07/mac). |
| Notion      | The heading block example contains rich text with independent bold/italic/strike/code annotations. The data model is verified; UI combinations and Markdown export remain **unverified**. [Block](https://developers.notion.com/reference/block), [annotations](https://developers.notion.com/reference/rich-text).                             |
| Typora      | Documents GFM, headings and inline formats. Heading support is a standards-based inference; exact UI/export combinations remain **unverified**. [Markdown reference](https://support.typora.io/Markdown-Reference/).                                                                                                                            |

Compose heading size/base weight with the inline style; do not apply heading font last and erase emphasis. Bold should remain visibly heavier than the heading base. Selected heading words have the paragraph's toggle semantics. [IF01](inline-formats.md#if01), [TS03](toolbar-and-shortcuts.md#ts03).

### E. Getting past an image or code block at EOF

Options: permanent trailing line; select-then-Enter; click below; arrow out. These may coexist, but a serialized newline alone does not provide a reachable caret.

- **CM6:** image insertion placed the caret at image-line end; 5fc5fda62 added a blank-last-code-line exit. !300's separate code-card draft supports whole-object selection and a press below a final block; it is not proof of shipped Milkdown behavior.
- **Milkdown:** a guaranteed trailing paragraph provides an exit; its unwritten blank is dropped on save. Tables also have Mod+Enter. The paragraph alone does not prove every click/arrow path worked.
- **Engine/native text-first:** selected-image Enter retains the image and adds a line below; complete code-body selection Enter acts after a closed fence. Empty-last-code-line Enter exits a final code block. A saved EOF code caret still belongs to code.
- **Desktop plan:** click selects atoms, arrows skip atoms and enter code, and !300 supplies code field/object precedent. Image exit still needs wiring and a story.

**Recommendation: guarantee select-then-Enter, retain unambiguous click-below and arrow exits, and avoid a permanently serialized parking line.** Preserve empty-last-code-line Enter and active Code-off. Desktop Backspace selects an image first, while !595's shared deletion deletes immediately; the renderer must implement that selection stage. [IM01](images.md#im01), [IM03](images.md#im03), [CB04](code-blocks.md#cb04), [CB05](code-blocks.md#cb05).

### B. Backspace at heading start

Options: demote first, join first, or expose/delete source syntax. CM6 edited physical source; Milkdown used block joins. Their complete historical key matrix remains **unverified**.

Mason's 8d40149a9 (2026-11-04), clarified by d0e7f7de9 (2026-11-05), defines desktop: remove a preceding blank while retaining heading; join preceding body text as body; do nothing at document start; demote only an empty heading. Setext has a separate path. Mobile BackspaceJoiningHeading deliberately demotes a first-line heading and historically refused code-boundary joins that !634 revises.

**Recommendation: retain the explicit desktop rule and tests; do not route desktop through the mobile command.** Check neighboring lists, quotes, code and tables as one sibling matrix. !634 also reports link destinations lost when joining a heading into code: preserve complete link Markdown as literal code, rather than accepting label-only loss. That product call remains open. [HG02](headings.md#hg02), [HG03](headings.md#hg03), [CS13](caret-and-selection.md#cs13).

### S. Keeping scroll on note return

Options: reopen at top; restore pixels; restore a logical text anchor; retain a live view. !33 promised per-tab scroll/selection across restarts; Justin's approved !97 triage on 2026-07-16 removed cross-restart selection restoration while keeping scroll. !410 fixed restoring pixels before a progressively opened tail was tall enough: wait for enough height or completed loading, and cancel if the reader scrolls.

**Recommendation: preserve per-tab scroll now and carry height-aware, cancelable restoration into progressive open.** Add logical anchors only when resize/outside-edit stability needs them. The complaint does not require a persistent editor cache. Mobile return-position policy remains **unverified**. [SV02](scrolling-and-viewport.md#sv02), [SV03](scrolling-and-viewport.md#sv03).

### M. Typed Markdown, conversion and escaping

**Resolved 2026-11-10** (Mason with Justin): the contract is in docs/plan/desktop-editor.md "Source-preserving formatting" and ADR 0013 on the engine branch `mason/source-preserving-markdown`, which owns the Rust changes. What follows is the history it came from.

Options: preserve typed source and render its meaning; escape punctuation to preserve an existing rich-text document; add an explicit literal mode. **Mason's 2026-11-10 decision rejects silent typed-marker escaping.**

December CM6 waited for block-line exit or a space after closing inline syntax (74cf4ba12); later CM6 used source and marker reveal. Milkdown !448 deliberately left hand-typed link syntax literal while autolinking its URL; !372 converted typed images. !394's owned serializer minimizes escapes by reparsing. On android-text-first, 28a0ba971/29e0f67b9 intentionally used escapes/entities to stop refused typing. Those fallbacks remain in this desktop engine.

The [escaping audit](escaping-audit.md) identifies current writers: typed-delimiter and flanking repair; final typed entities; block/list protection; Code-off literalization; link labels, destinations and titles; exposed reference definitions; table pipes; clipboard spellings; image validation; leading tabs. It separately lists Milkdown's candidate, field and structural writers. This is a searched inventory, not proof of every emitting branch.

**Recommendation: make typed source authoritative and derive live conversion from it; retain author-written escapes.** Keep explicit literal commands and field encodings distinct. Resolve table pipes, carried formats beside ambiguous delimiters, and typed link/image examples before replacing fallbacks. This is a real implementation/spec conflict; neither dropped input nor hidden escaping is acceptable. [MD01](markdown-fidelity.md#md01), [MD10](markdown-fidelity.md#md10).

### T. Toolbar mixed selections and list reversals

!275 used any-occurrence mark highlighting; current specs use the whole eligible selected inline content, so a lit button promises removal. Mason also requires disabled inapplicable commands and active-button toggle-off. **Recommendation: keep whole-selection coverage, mixed blocks unlit, and unsupported controls visible but disabled.** [TS02](toolbar-and-shortcuts.md#ts02), [TS03](toolbar-and-shortcuts.md#ts03).

!599's empty-item acceptance and !604's final sibling nesting supersede held-indent/refusal examples. !632 removes inserted HTML comments and drops !613's root-Outdent proposal. **Recommendation: integrate these reversals before using local lists.md as an oracle.** [LQ05](lists-tasks-quotes.md#lq05), [LQ07](lists-tasks-quotes.md#lq07), [LQ16](lists-tasks-quotes.md#lq16).

### F. Source fidelity versus house style

Milkdown normalized the whole note on first edit; the new engine preserves untouched source. The store still appends LF/CRLF to a nonempty authored write when absent, preserving existing terminal blanks. **Recommendation: keep that explicit save boundary, distinguish exact in-memory Undo from disk serialization, and pin LF/CRLF/no-ending cases.** [MD02](markdown-fidelity.md#md02), [MD03](markdown-fidelity.md#md03).

### X. Exit order

!167/!168 originally drained before navigation. Current native Back leaves first under a retained draft register, while desktop keeps a failed-save draft visible. Older wikilink lines still state the previous native order. **Recommendation: preserve desktop save-before-leaving and mobile nonblocking Back; reconcile stale native lines in integration work.** [OS20](open-save-rename-outside-changes.md#os20).

### U. Unicode whitespace in tags

!220 records BOM/NEL differences between JavaScript and Rust; the current differential still permits them. Options: Rust Unicode whitespace, JavaScript whitespace, or an explicitly shared set. **Recommendation: use the canonical Rust result on desktop and specify these two characters before changing the mirror.** [TG09](tags-and-front-matter.md#tg09).

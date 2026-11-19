# Tags and front matter

### TG01

- **Rule:** Tags follow the canonical boundary, name-length, case and code-isolation rules while remaining ordinary editable text.
- **Why / history:** A decoration is not a second tag parser; entity-encoded leading whitespace once made displayed tags disappear from filters.
- **Evidence:** docs/spec/editor/tags.md; !477 discussion; portable-core/tags.md
- **Applies:** `slice 7`. **Check:** tests/tags.rs; tests/conformance tag goldens

### TG02

- **Rule:** The desktop tag bar edits a leading content tag block and removing its last tag removes that block.
- **Why / history:** The tag bar is desktop-only by the 2026-06-09 decision; Enter/comma commits completion or a new tag.
- **Evidence:** docs/spec/editor/tag-bar.md; portable-core/tags.md
- **Applies:** `slice 7`. **Check:** tests/tags.rs; needs desktop tag-bar story

### TG03

- **Rule:** Header tags stay reachable as body text rather than disappearing behind an unreachable hidden node.
- **Why / history:** Milkdown reversed CM6's cursor-dependent hiding because mobile has no separate tag editor.
- **Evidence:** !275; docs/spec/editor/tags.md
- **Applies:** `slice 7`. **Check:** needs a desktop decision about visible body tags plus tag-bar duplication

### TG04

- **Rule:** A leading closed YAML front matter block retains exact bytes and is inert to body editing.
- **Why / history:** BOM, CRLF and fence whitespace survive; no front matter closer means ordinary Markdown, not swallowed containers.
- **Evidence:** !371; portable-core/foreign-content.md
- **Applies:** `slice 7`. **Check:** tests/foreign.rs; needs desktop metadata-panel story

### TG05

- **Rule:** The initial caret and document-start shortcuts land after front matter, and Backspace there does not damage metadata.
- **Why / history:** !448 consolidated front-matter caret handling; whole-note body edits change only the permitted body region.
- **Evidence:** !448; portable-core/foreign-content.md
- **Applies:** `slice 7`. **Check:** tests/foreign.rs; needs start-of-document/Select All story

### TG06

- **Rule:** Tag edits preserve selection, source outside the header and exact Undo as one action.
- **Why / history:** The engine performs header-window work rather than scanning the whole document per key.
- **Evidence:** portable-core/tags.md
- **Applies:** `slice 7`. **Check:** tests/tags.rs; store editor-session tag tests

### TG07

- **Rule:** Raw HTML, footnotes and unsupported syntax remain visible and recoverable rather than silently disappearing.
- **Why / history:** The engine treats HTML as editable literal text and footnotes as exact source; malformed Markdown still opens with nonblank display.
- **Evidence:** portable-core/foreign-content.md; #300
- **Applies:** `slice 7`. **Check:** tests/foreign.rs; needs malformed/HTML desktop stories

### TG08

- **Rule:** Moving to the body start above a divider gives a typing caret without selecting or deleting the divider.
- **Why / history:** Front matter once trapped upward movement and left typing nowhere to land; Shift-to-body-start excludes the opening divider, while metadata-only notes still provide an editable body position.
- **Evidence:** markdown-elements.md, YAML front matter; tests/editor-embed-milkdown-front-matter.spec.ts.
- **Applies:** `slice 7`. **Check:** needs front-matter-plus-divider and metadata-only document stories.

### TG09

- **Rule:** The editor's tag interpretation follows the canonical rule for Unicode whitespace.
- **Why / history:** !220 exposed opposite BOM and NEL boundary behavior in JavaScript and Rust, explicitly left unresolved there; current Rust still uses char::is_whitespace and the differential records the exception.
- **Evidence:** !220; crates/futo-notes-tags/src/lib.rs; tests/conformance/title-rules-differential/known-gaps.mjs.
- **Applies:** `slice 7`. **Check:** needs a spec line resolving BOM/NEL before reusing the TS scanner in the desktop; do not silently bless both interpretations.

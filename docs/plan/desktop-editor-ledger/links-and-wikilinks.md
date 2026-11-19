# Links and wikilinks

### LK01

- **Rule:** A typed bare web address becomes a link at the parser's actual word boundary.
- **Why / history:** Orhan requested clickable URLs before !1; !336 later restored word-ending autolinks; fresh google.com tapping is a recurrence candidate.
- **Evidence:** !1; !336; portable-core/links.md; maintainer list, 2026-11-10
- **Applies:** `slice 5`. **Check:** tests/links/word_end.rs; needs desktop bare-domain story

### LK02

- **Rule:** Punctuation that belongs to a URL is not consumed as an inline-format closer.
- **Why / history:** !468's review found escape loss when a following space retriggered emphasis; preserve existing escaped neighbors too.
- **Evidence:** !468 discussion; #273; portable-core/links.md
- **Applies:** `slice 5`. **Check:** needs URL-with-asterisk/underscore/tilde desktop stories

### LK03

- **Rule:** Only the link's actual glyphs activate it, including on wrapped rows.
- **Why / history:** The live-preview tail hit box once swallowed blank space; July fixed placing the caret past a wrapped link.
- **Evidence:** dbbf751a2; docs/spec/editor/external-links.md
- **Applies:** `slice 5`. **Check:** needs wrapped-link hit-area story

### LK04

- **Rule:** External navigation uses the system opener and never replaces the editor page.
- **Why / history:** c76ee9b4 changed navigation in 2026-03; !153 review tightened iOS file navigation to the exact bundled editor.
- **Evidence:** c76ee9b40; !153 discussion; external-links.md
- **Applies:** `slice 5`. **Check:** needs desktop opener story

### LK05

- **Rule:** A destination without a scheme is a relative note path and opens only an existing note.
- **Why / history:** Justin approved !631 on 2026-11-09: .md optional, leading slash vault-relative, query and fragment ignored; unknown targets do nothing.
- **Evidence:** !631; 63e2de4a2 (later origin/main)
- **Applies:** `slice 5`. **Check:** needs a local spec update and note-path story

### LK06

- **Rule:** Only http, https, mailto, tel and sms schemes may open externally.
- **Why / history:** !631's shared rule includes sms; #401 records Android and desktop dev opener lagging behind iOS.
- **Evidence:** !631; #401
- **Applies:** `slice 5`. **Check:** needs a desktop scheme allowlist story; do not claim sms already works locally

### LK07

- **Rule:** The Link prompt adds https only to addresses that clearly look like web addresses.
- **Why / history:** !631 keeps setup.sh, main.rs and ambiguous note paths literal rather than sending them to a browser.
- **Evidence:** !631; 04d2de890 (later origin/main)
- **Applies:** `slice 5`. **Check:** needs normalization and file-like-destination stories

### LK08

- **Rule:** A Link prompt belongs to the note and document version on which it opened.
- **Why / history:** !484 fixed same-byte note switches bypassing cleanup; !536 closes stale URL fields on document edits.
- **Evidence:** !484; !536; markdown-toolbar/toolbar-commands.md
- **Applies:** `slice 5`. **Check:** needs keyboard note-switch and edit-under-prompt stories

### LK09

- **Rule:** Link editing preserves selected text, existing marks, title and unchanged reference uses as one Undo action.
- **Why / history:** !629 folds partial-emphasis and multiline-label fixes; !575 adds atomic label/destination editing.
- **Evidence:** !575; !629; portable-core/links.md
- **Applies:** `slice 5`. **Check:** tests/links/commands.rs; tests/links/reference_blocks.rs

### LK10

- **Rule:** Linking a selection over a table links each cell body without changing table shape.
- **Why / history:** !635 rejects damaging results and keeps selection on the same text even when reference definitions become visible.
- **Evidence:** !635; #363; #368
- **Applies:** `slice 9`. **Check:** needs table-link story; remaining pipe destinations and check cost are open

### LK11

- **Rule:** A wikilink uses the canonical target grammar and shortest unique label.
- **Why / history:** The entire inner target includes |alias in this app; source spelling remains intact and unresolved targets remain visibly distinct.
- **Evidence:** portable-core/wikilinks.md; !364
- **Applies:** `slice 5`. **Check:** tests/wikilinks.rs; needs resolved/ambiguous/broken desktop story

### LK12

- **Rule:** Wikilink completion consumes Enter and Tab before list or table navigation.
- **Why / history:** !364 fixed checked-task and table-cell completion; acceptance is one Undo and stale claims cannot insert.
- **Evidence:** !364; portable-core/wikilinks.md
- **Applies:** `slice 5`. **Check:** tests/wikilink_completion.rs; needs keyboard-priority story

### LK13

- **Rule:** Modifier and middle-click wikilinks retain background-tab navigation.
- **Why / history:** !338 added missing auxclick routing; independent rapid clicks are not swallowed by a global debounce.
- **Evidence:** !338; docs/spec/editor/wikilinks.md
- **Applies:** `slice 5`. **Check:** needs desktop modifier-click story

### LK14

- **Rule:** A missing wikilink creates a note only when navigation is deliberately followed.
- **Why / history:** The original 2026-03 eager creation was narrowed to lazy creation, avoiding file creation just from rendering.
- **Evidence:** bb1baebdc; !35; docs/spec/editor/wikilinks.md
- **Applies:** `slice 5`. **Check:** needs create-on-follow story; ordinary Markdown note links instead do nothing when absent

### LK15

- **Rule:** Inserting a link at a plain caret uses its URL as the label and leaves that label selected for replacement.
- **Why / history:** The shared prompt replaced the old scaffold; Escape, outside click or an empty new URL cancels without changing the note. Slash-command query removal has its own explicit command contract.
- **Evidence:** markdown-toolbar/toolbar-commands.md; docs/spec/editor/interactive-elements.md.
- **Applies:** `slice 5`. **Check:** needs new-link, replace-label, empty-submit and cancel stories.

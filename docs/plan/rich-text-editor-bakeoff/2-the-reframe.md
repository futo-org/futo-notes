## 2. The reframe that shapes everything

The motivating CM6 bug — bold two words, put the caret in the middle, press
Enter, rendering breaks — is a **source-integrity bug, not a rendering bug**.
The editor writes `**bo⏎ld**` into the file; that genuinely is not bold in
CommonMark; live preview then renders the broken source faithfully.

The missing piece is a layer that compiles the _intent_ ("split this
paragraph") into well-formed markdown (`**bo**⏎⏎**ld**`). The
`codex/tiptap-desktop` branch already emits exactly that for the same
keystroke (locked in `tests/tiptap-desktop-roundtrip.spec.ts`, "Enter inside
bold serializes only the edited paragraph region").

**Consequence: every approach must own "edits never produce malformed
markdown." That obligation is orthogonal to which model owns the document** —
it exists whether truth is a source string, a token stream, or a semantic
tree. The approaches differ in where that layer lives and what it costs.

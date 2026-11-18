# Links and wikilinks (`lk`)

Source: `origin/desktop/new-editor:docs/spec/editor/desktop/links.md`. Ruling: measure Mason's rules on Android; Android's tap rule stays.

| # | Desktop does | Kind | Phone form / reason | Android now | Action |
| --- | --- | --- | --- | --- | --- |
| lk-1 | Shows a link's label only, underlined; a typed `[text](url)` becomes a link once valid. | host: phone form | The same. | same | measured |
| lk-2 | Shows a wikilink's shortest-suffix label, dashed; an unresolved one muted, as written. | host: phone form | The same. | same | measured |
| lk-3 | A plain click on a link opens it on release; no caret move; a 4px drag selects instead. | host: phone form | Android's tap rule: a short tap follows the link. | same (external-links.md; wikilinks.md wrap line) | none |
| lk-4 | A wikilink opens its note, else creates one, deleted again if left untouched. | Android's earlier decision (wikilinks.md, 2026-07-11): deferred creation | A tap. | a tap on a missing wikilink places the caret at its nearer edge; nothing is written (checked on the emulator with the vault listing: tap, double tap, typing). The spec'd phone form (open an empty editor titled with the target, write the file on the first edit) is not built: the editor cannot open a note that has no file | not built: needs the editor to open a missing note (a note-lifetime change: do not build without Mason) |
| lk-5 | Opens what the engine says a destination names: a note from this folder, else the external address. | engine | `resolve_note_link`, `external_link_url`. | a tap on a web link opens the browser, keyboard up or down; a tap on a Markdown link to a note places the caret | recorded (Android's tap rule kept by ruling) |
| lk-6 | A caret at a link's edge is outside it, so a link never grows at its edge. | host: phone form | A tap at the label's end, then typing. | same | measured |
| lk-7 | A wikilink is one unit: no caret inside; Backspace after it deletes it whole. | host: phone form | The same. | built: Backspace after or Delete before a wikilink takes it whole, one Undo (e0d9b4610). Before: Backspace took one `]` | built |
| lk-8 | Toolbar Link and Mod+K open a URL prompt: Add or Update; empty removes; saves `normalize_link_destination`. | host: phone form | The toolbar's Link opens Android's form; hardware Ctrl+K. | built: the form saves through normalize_link_destination (`example.com` becomes `https://example.com`); hardware Ctrl+K opens it (TextFirstDesktopRulesTest) | built |
| lk-9 | The prompt belongs to the note and version it opened on. | host: phone form | The same. | same: input invalidates the form (external-links.md) | none |
| lk-10 | `[[` lists matching notes (up to 20); Up/Down, Enter/Tab or a click accepts; Escape closes. | host: phone form | A tap on a row; hardware keys as desktop. | built: `[[` auto-closes and lists notes; a tap picks one; hardware Up/Down move a highlighted row, Enter or Tab take it, Escape closes the list (TextFirstCompletionKeysTest) | built |

The two desktop gaps (`sms:` links; Backspace into a label's first letter) are desktop findings, not rows.

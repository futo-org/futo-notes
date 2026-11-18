# Links and wikilinks (`lk`)

Source: `origin/desktop/new-editor:docs/spec/editor/desktop/links.md`. Ruling: measure Mason's rules on Android; Android's tap rule stays.

| # | Desktop does | Kind | Phone form / reason | Android now | Action |
| --- | --- | --- | --- | --- | --- |
| lk-1 | Shows a link's label only, underlined; a typed `[text](url)` becomes a link once valid. | host: phone form | The same. | same | measured |
| lk-2 | Shows a wikilink's shortest-suffix label, dashed; an unresolved one muted, as written. | host: phone form | The same. | same | measured |
| lk-3 | A plain click on a link opens it on release; no caret move; a 4px drag selects instead. | host: phone form | Android's tap rule: a short tap follows the link. | same (external-links.md; wikilinks.md wrap line) | none |
| lk-4 | A wikilink opens its note, else creates one, deleted again if left untouched. | host: phone form | A tap. | built: a tap on a missing wikilink creates the note through the store and opens it as a new note; untouched, it is deleted on leaving (TextFirstMissingWikilinkTest) | built |
| lk-5 | Opens what the engine says a destination names: a note from this folder, else the external address. | engine | `resolve_note_link`, `external_link_url`. | a tap on a web link opens the browser, keyboard up or down; a tap on a Markdown link to a note places the caret | recorded (Android's tap rule kept by ruling) |
| lk-6 | A caret at a link's edge is outside it, so a link never grows at its edge. | host: phone form | A tap at the label's end, then typing. | same | measured |
| lk-7 | A wikilink is one unit: no caret inside; Backspace after it deletes it whole. | host: phone form | The same. | built: Backspace after or Delete before a wikilink takes it whole, one Undo (e0d9b4610). Before: Backspace took one `]` | built |
| lk-8 | Toolbar Link and Mod+K open a URL prompt: Add or Update; empty removes; saves `normalize_link_destination`. | host: phone form | The toolbar's Link opens Android's form; hardware Ctrl+K. | form as before; `example.com` is saved as written (no https://); no Ctrl+K | differs; host, small; not built |
| lk-9 | The prompt belongs to the note and version it opened on. | host: phone form | The same. | same: input invalidates the form (external-links.md) | none |
| lk-10 | `[[` lists matching notes (up to 20); Up/Down, Enter/Tab or a click accepts; Escape closes. | host: phone form | A tap on a row; hardware keys as desktop. | `[[` auto-closes and lists notes; a tap picks one; hardware Enter/Tab/Up/Down do not drive the list | differs (hardware keys); host, ~50 lines; not built |

The two desktop gaps (`sms:` links; Backspace into a label's first letter) are desktop findings, not rows.

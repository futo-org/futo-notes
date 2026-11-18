# Tags and front matter (`tg`)

Source: `origin/desktop/new-editor:docs/spec/editor/desktop/tags.md`. Ruling: leave Android as it is (not answered).

| # | Desktop does | Kind | Phone form / reason | Android now | Action |
| --- | --- | --- | --- | --- | --- |
| tg-1 | Colours a `#tag` the engine reports, nothing else; a tap places the caret. | engine | tags.md: the host colours the reported range. | as it is | none |
| tg-2 | Keeps the header tag block as text while the tag bar shows chips. | Android's earlier decision | Tag bar is desktop-only (tag-bar.md, 2026-06-09); phones edit tags as text. | text only | none |
| tg-3 | Tag bar chips add and remove tags through the engine, one Undo each. | Android's earlier decision | Same decision. | no tag bar | none |
| tg-4 | A tag typed in the bar belongs to the note it started on. | Android's earlier decision | Same decision. | no tag bar | none |
| tg-5 | With the vault unusable, the bar shows tags read-only. | Android's earlier decision | Same decision. | no tag bar | none |
| tg-6 | Shows front matter as an inert muted panel; the caret never rests in it. | engine | foreign-content.md (caret rule); the panel is host. | monospace strip, open (V 3.10) | none |

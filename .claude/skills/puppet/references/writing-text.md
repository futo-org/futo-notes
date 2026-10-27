## Writing text: fast, or real

The editor shows a rendered document, not markdown: a heading is a heading, bold a mark on
the text, a task's box a flag on its item. `doc` gives each line's caret positions (`at`-`end`,
ProseMirror's own: a block boundary is a position too), its kind (`heading 1`, `task ☐`,
`code js`, `cell r2c1`), the text on screen, and the markdown that will be saved where it
differs. Positions come from `doc`, `show {"text"}` and `state`, never from counting markdown.

`AppendLine`, `InsertLine`, `ReplaceLine`, `Insert` and `Replace` are much faster — one call,
no caret, the text read as markdown (`- [ ] tea` is a task) — but **they are not input a person
can produce**: no key handler or input rule runs. Use them to arrange a document. When the
behaviour you are looking for comes from **typed input** (what Enter does in a list, `# ` making
a heading, `[[` suggestions, autosave per keystroke, anything a keypress triggers), use the verbs
that mimic it — `PlaceCaret`/`Select`, then `Type` and `Press` — or you are testing a path no
user takes. `actions` marks the fast ones `"convenience": true`.

The argument names agents guess wrong most: `Replace {"find":"…","text":"…"}` (not `with`),
`PlaceCaret {"at":N}` (not `offset`), `InsertLine {"afterLine":N,"text":"…"}`, `Insert
{"text":"…"}` with one of `at`, `after` or `before` (no `expect`: that is `Select`'s and
`Replace`'s). A misnamed one is refused with the call it meant: `did you mean "at"? do
PlaceCaret '{"at":16}'`.

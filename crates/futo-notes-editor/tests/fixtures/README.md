# Editor fixtures

Two sets of literal cases, both shared by the Rust tests and the WebAssembly consumers.

## Commands

`engine/` holds the core's command cases, one file (or folder) per family: blocks, fences, lists,
tables, inline formatting and links, clipboard, images, wikilinks and tags, find. Each case is the
note before with the selection marked (`|` or `‸` a caret, `[` `]` or `«` `»` a selection; a case's
`marks` field names other characters when the note needs these), the command, and the note after,
marked the same way. The family's runner in `src/engine/tests/` replays every case and also undoes
and redoes it. `tests/wasm-fixture-replay.mjs` replays the block, fence, plain-Enter and list cases
through the compiled WebAssembly session and the real store worker, and
`crates/futo-notes-ffi/tests/editor_list_actions.rs` replays the list cases through the native
surface with a save and reopen.

## Linedown reading

`linedown/` holds the reading cases, one file per theme, for `docs/spec/editor/portable-core/linedown.md`: for
each `input`, one string per line naming what the line reader reports — the block (`plain`,
`plain i2` for a plain line indented 2 columns, `blank`, `h2`, `bullet i0 -`,
`number i2 3)`, `task i0 - [x]`, `divider`, `fence-open js`, `code`, `fence-close`,
`front-open`, `front`, `front-close`, `table-header 2`, `table-delimiter 2`, `table-row 2`),
a `q1 ` prefix for quote depth (an indent is the line's own leading width after any quote
marker: a space is 1 column, a tab 4), ` : ` and the line's content, then each inline mark as
`[kind source]`. Every case names the spec rule or "Differences" row it pins. The fixtures
assert what each line is, never HTML. `src/lines/tests.rs` runs them, checks that re-reading
after any edit equals a fresh read, and checks that text added below never changes a line
above (the table header excepted).

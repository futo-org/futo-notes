# Tags and header tags

Tag grammar is the canonical shared rule set, not an editor copy: boundary, digit
start, 50-character limit, case-insensitive deduplication and code isolation come from
`futo-notes-tags` (also re-exported by `futo-notes-model` and used by notes metadata).
The shipping renderer's tag decoration contract is unchanged. See `docs/spec/editor/tags.md`.

- Tag queries return canonical `#name` tags in first-seen order from the note body, skipping inline and fenced code; `header_tags` returns the leading block of tag-only lines, which stays ordinary editable text. Queries are on-demand scans; no edit runs one. → crates/futo-notes-tags/src/lib.rs, crates/futo-notes-editor/src/session/tags.rs, crates/futo-notes-editor/tests/tags.rs
- Adding a header tag normalizes its spelling, rejects invalid names, creates the block (with its blank separator and the note's line ending) when absent, appends to the last tag line otherwise, and changes nothing when the tag is already present. → crates/futo-notes-editor/tests/tags.rs
- Removing a header tag deletes every spelling of it from the block, keeps all other bytes, drops a line left without tags and, when the block empties, its separator. → crates/futo-notes-editor/tests/tags.rs
- Each change is one isolated accepted edit through the ordinary input path: the caret and selection are carried across it, Undo/Redo restore exact bytes and selection, recovery replays the one record, and refused acceptance changes nothing. Work stays in the header window regardless of note size. → crates/futo-notes-store/src/tests/editor_session/tags.rs, crates/futo-notes-editor/tests/tags.rs
- Seam for front matter (#300): `EditorSession::tag_body_start` is the one place that names the first body byte; tags and header tags are scanned and edited only from there.

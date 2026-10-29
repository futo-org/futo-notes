# Portable text-first core

This core is under development for #283. Shipping apps continue using the shared
Milkdown editor until a separate renderer integration and cutover.

- A plain-note session opens exact UTF-8 source, including CRLF, trailing whitespace and final-newline spelling; opening and dropping an unchanged store session writes neither the note nor a recovery file. → crates/futo-notes-editor, crates/futo-notes-store/src/editor_session
- Plain-text insertion, deletion and replacement use distinct source/display UTF-8 byte coordinates; revision-checked conversions expose distinct source/display UTF-16 code-unit ranges for native hosts. Display and source correspond directly for this plain-text slice. → crates/futo-notes-editor/src/coordinates.rs
- Reversed or out-of-range edits, UTF-8 character splits, UTF-16 surrogate splits, unpaired surrogate input and stale revisions reject explicitly before recovery acceptance, leaving text, selection and history unchanged; input preserves exact line endings and Unicode spelling. → crates/futo-notes-editor/src/coordinates.rs, crates/futo-notes-editor/tests/unicode.rs
- Selection-only updates carry the current source revision and create no source delta, recovery record or history step; Undo/Redo restore the exact selection before/after their original edit. → crates/futo-notes-editor/src/session.rs
- Caret movement and selection collapse stop at extended grapheme boundaries, including combining sequences, joined emoji, flags and CRLF; valid foreign replacement ranges may address code-point boundaries within a grapheme. → crates/futo-notes-editor/src/movement.rs
- Input acceptance holds an exclusive session borrow that prevents synchronous callback re-entry; repeated native notifications using the original revision reject before host acceptance. → crates/futo-notes-editor/src/session.rs, crates/futo-notes-editor/tests/unicode.rs
- Each successful operation returns one ordered display replacement, its resulting selection and the accepted revision; views apply these changes without parsing source. The portable callback is a host acceptance seam, not a WebAssembly durability acknowledgement. → crates/futo-notes-editor/src/types.rs, crates/futo-notes-editor/tests/common/mod.rs
- Basic Undo and Redo restore exact bytes one action at a time and pass through the same recovery acceptance boundary as replacement. Undo history is in-session only. → crates/futo-notes-editor/src/session.rs
- The store accepts each completed edit into an unbuffered recovery stream before returning its display change; process exit can lose the operation being applied, but reopening replays every previously accepted edit. OS acceptance alone is not a power-loss durability acknowledgement. → crates/futo-notes-store/src/editor_session/recovery.rs
- Recovery records stay in the vault's hidden `.futo-editor-recovery` directory, excluded from visible note listings and sync inventory; the header binds the stream to its canonical vault root and note id. The first edit initializes the stream with its exact base. → crates/futo-notes-store/src/editor_session/recovery.rs
- One process can attach only one session to a note's recovery stream, including through different store handles. Independent app processes editing the same vault remain unsupported, as for the existing local note engine. → crates/futo-notes-store/src/editor_session/lease.rs
- Checkpoint owns the write/converge/recreate/park decision and log retirement under the store gate and vault mutation guard. It returns the existing flush disposition and complete mutation; the installed note is synced before the log is retired. → crates/futo-notes-store/src/editor_session/mod.rs, crates/futo-notes-store/src/flush.rs
- A checkpoint that commits markdown but fails its durability check or recovery retirement reports the committed disposition and complete mutation in `CheckpointCommitted`; the draft remains copyable, edits pause, and checkpoint can retry without repeating the committed save decision. A markdown-write failure leaves the healthy recovery stream available. → crates/futo-notes-store/src/editor_session/mod.rs

Durable sequence acknowledgements, timed flush scheduling, invalid-log salvage,
outside-writer/lifecycle coordination,
markdown interpretation and platform facades follow in their dependent tickets.
The current work counters report engine-materialized source and inserted bytes;
they do not claim parser work bounds or native device latency measurements.

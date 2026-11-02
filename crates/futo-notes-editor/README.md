# Portable editor session and recovery handoff

The shipping editor stays unchanged. `EditorSession` is the native exact-source
engine; `PortableSession` adds the asynchronous page/worker handshake, and the
`wasm32-unknown-unknown` build exports `WasmSession` through wasm-bindgen.
The WASM dependency graph contains no store, filesystem, shell or network engine.

A native host opens `LocalNoteStore::open_editor` on its background worker. It
consumes the store session with `into_portable_host(token)?` and supplies the
worker's `snapshot()` to the page through `PortableSession::from_snapshot` or
`WasmSession.restore`. This carries the recovered source, revision, durable
watermark, pause and a fresh `SessionToken`. Conversion waits for any in-flight
identity/checkpoint workflow before changing the attachment role and reports lock
or deleted-attachment failures. A pending native identity adoption rejects
conversion until normal identity recovery finishes; ordinary paused recovery
still opens a copyable portable page. Native recovery UI reads the store's
structured diagnostic through `StoreEditorHost::recovery_issue`. Tokens identify an incarnation, not a note title;
never reuse one across a note switch or page reload. The JSON WASM facade requires
initial integer values within JavaScript's exact integer range.

1. `replace` / `replace_utf16` / `toggle_format` / `undo` / `redo` produce one `HostRequest` containing
   only the validated source replacement. This is page-local completion: the
   copyable draft has changed, but the view and accepted watermark have not.
2. Send the request to the worker. `StoreEditorHost::handle` validates the token,
   request sequence, source revision and exact removed bytes, then appends through
   the real store recovery owner before applying the replacement once.
3. Deliver its `HostAck` to `acknowledge`. Only a matching successful append ACK
   releases a `ViewChange`. Apply that delta to the view. No next input is accepted
   while the active edit awaits acknowledgement: there is no displayed timer queue.
4. A `flush` request runs recovery flush on the worker. Append acceptance protects
   against process death; successful flush acknowledges power-loss durability.
   Neither watermark means the Markdown file has been checkpointed.

`project(revision, display_range)` supplies display text, semantic runs, block descriptions (heading level, quote depth and divider identity) and exact
source/display correspondence for the requested window. `select_with_affinity`
chooses the visible neighbor at a hidden boundary. Formatting toggles preserve
display text and selection, but their source edits still require worker acceptance.
Collapsed toggles carry formatting locally without emitting a recovery record.
Queries and selection reject while an edit is pending, so a staged projection cannot
overtake the acknowledged view. A paused recovered session can still query its
accepted projection for display and copying. Apply `ViewChange.projection` even when the display
replacement is empty or unchanged. The WASM JSON methods accept affinity and format
as serialized enum strings, for example `'"Forward"'` and `'"Strike"'`.

`handle` blocks on storage and belongs on the worker, including initial open.
The session runs no timer. Query `StoreEditorHost::recovery_flush_delay` for the
oldest unflushed edit's remaining delay and arrange the next `flush` request
without postponing that deadline for later edits. A delayed timer never grants
durability by itself. An outstanding append still has priority; flush as soon as
it completes if the deadline has elapsed. Native scheduling/device latency is not
measured by this portable consumer.

On failed appends or flushes, retain the page and its copyable draft and pause
input. `resume` invalidates an outstanding transport request and asks the worker
to repair/flush the accepted prefix. If the edit was accepted but its reply was
lost, the resumed acknowledgement releases the pending delta once. Otherwise,
`retry_pending` sends the retained active edit after successful resume. A failed
resume stays paused. Old tokens, duplicate replies and superseded request replies
never release another delta or regress watermarks. Keep requests in a single
ordered worker queue; do not reopen or switch the host while a page is attached.
After page loss, reopen from the store's recovered source with a new token.

Run `just test-editor-wasm` to compile actual WASM and execute its Node consumer
against a separate Rust store worker process. It installs the wasm target and a
matching task-local wasm-bindgen CLI if needed; `WASM_BINDGEN=/path/to/wasm-bindgen`
selects an already installed matching binary. Generated output lives under
Cargo's ignored target directory. The existing blocking Rust workspace CI job
runs this consumer and remains a dependency of the release gate.

`block_command_utf16` accepts `Heading(0..=6)`, explicit `Quote`, quote
`Indent`/`Outdent`, and `Divider`. The WASM JSON command argument is an enum
value such as `'{"Heading": 2}'` or `'"Divider"'`. `paragraph_key_utf16`
uses the same engine for structural heading/quote Enter and exit rules.
Commands, shortcut conversions and history use the existing protected append
workflow; native callers receive equivalent descriptions through regenerated
UniFFI bindings. Renderer integration and shipping defaults are unchanged.

Link interpretation belongs to the canonical parser, while input timing belongs
only to an actual supplied in-session lifetime. Opening, recovery and equal text
cannot mint that lifetime. Standard saved spelling preserves visible text and
canonical destination independently of whether a live link is still pending.
`PendingLinks` carries explicit scoped replacement, including an empty result;
missing scope is not a retirement decision. Code-word and Typed lifetimes remain
separate roles even when they share a canonical URI identity.

Exact source points include complete decoded-atom witnesses. Staged source edits
transport points in execution order; an exact child of a Derived body cannot
restore original ancestry. `BodySource` uses actual rendered piece correspondence,
and structural commands verify the resulting physical parent before acceptance.
Reference-dependent actions use the current canonical winner and generation,
including after a declaration becomes visible or a body changes container form.
Equal text, raw lengths and semantic caret diff runs are not source lineage.

Own-action relink is one ordinary isolated edit: the store supplies the exact
rewritten note, the session replaces the changed byte window and pushes one
Undo step. Existing history is not rewritten. The behavior is indexed in
[persistence and recovery](../../docs/spec/editor/portable-core/recovery.md).

`EditWork` separates supplied parser bytes, source materialization, owned meaning
copies and charged metadata/correspondence work. The bare-link primitive returns
its existing `ReferenceWork` at the owner, including one item per pulldown
event walked and emitted meanings; consumers add their own local inspection
without reconstructing those copies. GFM autolink literals follow markdown-rs
1.0's grammar over pulldown's inline text; reference definitions, duplicates
included, come from pulldown too, so no scan can panic on user text (the
markdown crate's tree builder did, #283). Counters do not measure parser CPU or all
allocations, Ropey's internal work, semantic caret diff CPU or native latency.
Genuine reference transitions and own-action relinks have explicit global
work; ordinary unrelated local input must retain its bounded paragraph path.

An outstanding Flush blocks new input and selection while queries still expose
the accepted projection. Retain a refused complete marked-text callback payload
until the matching reply is acknowledged, then retry that same update once;
do not replace it with an unaccepted display queue. Native hosts obtain the same
Store-clock remaining recovery duration through the FFI projection. The public
withheld-reply examples demonstrate protocol mechanics, not blocked-I/O timing,
OS callback capture or physical durability.

# Portable editor session and worker protocol

The shipping editor stays unchanged. `EditorSession` is the native exact-source
engine; `PortableSession` adds the page/worker mirror protocol, and the
`wasm32-unknown-unknown` build exports `WasmSession` through wasm-bindgen.
The WASM dependency graph contains no store, filesystem, shell or network engine.

A native host opens `LocalNoteStore::open_editor` on its background worker. It
consumes the store session with `into_portable_host(token)?` and supplies the
worker's `snapshot()` to the page through `PortableSession::from_snapshot` or
`WasmSession.restore`. The snapshot carries the source, revision, pause and a
fresh `SessionToken`. Tokens identify an incarnation, not a note title; never
reuse one across a note switch or page reload. The JSON WASM facade requires
initial integer values within JavaScript's exact integer range.

The worker applies edits in memory and saves the markdown on a debounce (500 ms
idle, 2 s max wait). The page never asks for a save.

1. Every edit (`replace*`, `toggle_format`, `undo`, `redo`, paste, ...) applies to
   the page's engine at once and returns `Applied { change, request }` (JSON
   `{change, request}`): show `change` immediately, then send `request` to the
   worker. Requests carry strictly increasing sequence numbers; any number may
   be outstanding, and queries, selection and composition never wait.
2. `StoreEditorHost::handle` validates token and sequence (an edit must be exactly
   the previous number plus one; a repeat of the last request is idempotent; a
   gap or old number is `Rejected`), then replays the edit in memory. It takes
   only the attachment lock, never the store gate.
3. Deliver its `HostAck` to `acknowledge`. A success only advances `accepted`;
   the view already shows the edit. An error ack (`Deleted`, `StaleToken`,
   `Rejected`) pauses the page: input is refused, queries keep working
   and the draft stays copyable. A relink offer in an ack is adopted only if its
   revision still equals the page's current revision.

`project(revision, display_range)` supplies display text, semantic runs, block descriptions (heading level, quote depth and divider identity) and exact
source/display correspondence runs (literal, hidden, replaced) for the requested window. `select_with_affinity`
chooses the visible neighbor at a hidden boundary. Formatting toggles preserve
display text and selection, and mirror their source edits to the worker like any
edit. Collapsed toggles carry formatting locally without emitting a request.
A paused session still queries its projection for display and copying. Apply
`ViewChange.projection` even when the display replacement is empty or unchanged. The WASM JSON methods accept affinity and format
as serialized enum strings, for example `'"Forward"'` and `'"Strike"'`.

The session runs no timer. The host loop asks `StoreEditorHost::save_delay`
for the time left and calls `save_if_due` (or `checkpoint` to save now).

To recover from a pause or a lost transport, call `resume`: it sends nothing but
a request for the worker's current state. Its reply, passed to `acknowledge`,
unpauses the page and returns the outstanding edit requests the worker has not
accepted, renumbered after the resume request and in order; send them. The worker
accepts a resume with any newer sequence number. Old tokens, duplicate replies and
replies for superseded numbers never regress the accepted revision. Send requests
to the worker in sequence order (one at a time, or over one ordered channel); do
not reopen or switch the host while a page is attached. After page loss, reopen
from the note's markdown with a new token.

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
Commands, shortcut conversions and history use the same apply-then-mirror
flow; native callers receive equivalent descriptions through regenerated
UniFFI bindings. Renderer integration and shipping defaults are unchanged.

Link interpretation belongs to the canonical parser, while input timing belongs
only to an actual supplied in-session lifetime. Opening and equal text
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
[persistence](../../docs/spec/editor/portable-core/recovery.md).

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

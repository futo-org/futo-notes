# Portable editor session and recovery handoff

The shipping editor stays unchanged. `EditorSession` is the native exact-source
engine; `PortableSession` adds the asynchronous page/worker handshake, and the
`wasm32-unknown-unknown` build exports `WasmSession` through wasm-bindgen.
The WASM dependency graph contains no store, filesystem, shell or network engine.

A native host opens `LocalNoteStore::open_editor` on its background worker. It
supplies the recovered source, revision, durable watermark and a fresh
`SessionToken` to the page, then consumes the store session with
`into_portable_host(token)`. Tokens identify an incarnation, not a note title;
never reuse one across a note switch or page reload. The JSON WASM facade requires
initial integer values within JavaScript's exact integer range.

1. `replace` / `replace_utf16` / `undo` / `redo` produce one `HostRequest` containing
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

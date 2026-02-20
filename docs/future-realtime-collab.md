# Future: Real-Time Collaboration with CRDTs

## Vision

- Share a link from your phone — anyone can edit in-browser, no app needed
- Permanent shared notes between app users (e.g., grocery list)
- Real-time co-editing with multiple cursors

## Why CRDTs

The current sync engine is hash-based: each note is a string, conflicts produce a copy ("server wins"). This works for single-user multi-device sync but breaks down for collaboration.

CRDTs (Conflict-Free Replicated Data Types) represent text as a sequence of operations (insert/delete at position) that merge in any order without conflicts. Two people can edit the same note simultaneously and both changes merge at the character level — no conflict copies.

## Yjs

[Yjs](https://docs.yjs.dev) is the leading CRDT library for text collaboration. Key pieces:

- **`Y.Doc`** — a CRDT document containing shared types (`Y.Text`, `Y.Map`, etc.)
- **`y-codemirror.next`** — CM6 binding. Replaces direct doc management with a shared `Y.Text`. Provides awareness (remote cursors), shared undo/redo.
- **Transport-agnostic** — Yjs syncs over WebSocket, SSE, WebRTC, or any custom channel. The current SSE notification layer can evolve into a CRDT update transport.
- **Binary encoding** — compact wire format, small deltas

## What Changes

| Layer | Current | With Yjs |
|-------|---------|----------|
| Editor | CM6 direct `doc` state | CM6 bound to `Y.Text` via `y-codemirror.next` |
| Storage (client) | Plain `.md` files | Yjs binary state + rendered `.md` export |
| Storage (server) | Plain `.md` files on disk | Yjs binary state in SQLite + `.md` export |
| Sync protocol | Full content + SHA-256 hashes | Yjs update deltas (binary, very small) |
| Conflict handling | Server wins + conflict copy | Automatic character-level merge (no conflicts) |
| Sharing | N/A | Yjs room per note, joined via link |

## Migration Path

1. **SSE first** (current plan) — add server push notifications for fast single-user sync. No sync engine changes. This becomes the transport layer for CRDT updates later.

2. **Yjs per-note** — wrap each note's content in a `Y.Doc` with a `Y.Text`. Bind CM6 to it via `y-codemirror.next`. Store Yjs binary state alongside (or instead of) plain text. The server merges Yjs updates instead of comparing hashes.

3. **Sharing** — a "share" action creates a room ID for a note's `Y.Doc`. A web client (no app needed) joins the room via the server. Auth is per-room (link = read/write token).

4. **Permanent shares** — app users can subscribe to shared notes. The note appears in both users' note lists and stays in sync via Yjs.

## Tradeoffs

- **Storage overhead**: Yjs state is ~1.5-3x the plain text size (stores edit history for merging). Can be compacted with `Y.encodeStateAsUpdate()`.
- **Debugging**: CRDT state is opaque binary. Need tooling to inspect.
- **Plain text export**: Must maintain `.md` rendering alongside CRDT state for interop (filesystem, other apps).
- **Complexity**: Significant rearchitecture. The editor, storage, sync engine, and server all change.

## Reference

- [Yjs docs](https://docs.yjs.dev)
- [y-codemirror.next](https://github.com/yjs/y-codemirror.next)
- [HedgeDoc](https://hedgedoc.org) — open-source collaborative markdown editor (uses Yjs)

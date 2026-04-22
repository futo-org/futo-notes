# Future: Sharing and Real-Time Collaboration

## Vision

- Share a link from your phone; anyone can open it in a browser
- Allow lightweight collaboration without requiring the full app
- Keep FUTO Notes's offline-first, filesystem-first model intact unless collaboration proves important enough to justify a rewrite
- Leave room for permanent shared notes and future multi-source vaults

## The Core Decision

There are really three different features that are easy to blur together:

1. **Read-only sharing** — send someone a link to view a note
2. **Editable sharing** — someone can edit a shared note in the browser
3. **True real-time collaboration** — multiple people type at once, see each other live, and merge at character granularity

FUTO Notes can ship value at each layer. A CRDT rewrite is only needed for the third layer, and only if we decide that real-time collaboration is important enough to change the storage and sync model.

## Current Constraints

FUTO Notes today is built around:

- Plain `.md` files as the durable note format
- A hash-based sync engine where each note is a whole string
- Offline-first local editing
- Conflict handling via "server wins" plus conflict copies

That works well for single-user, multi-device sync. It is not a natural fit for multiple people editing the same note at once.

## Option 1: Simple Sharing First

The simplest path is:

- Add share links for read-only notes
- Add optional browser editing with a single-writer lock
- Persist plain markdown back to disk on the server
- Let normal sync pick up the changes afterward

This avoids introducing a second durable note model. It is the best fit if collaboration is useful but not central to the product.

## Option 2: CodeMirror's Built-In Collaboration

CodeMirror 6 has an official collaboration package: [`@codemirror/collab`](https://codemirror.net/docs/ref/#collab).

This is **not** CRDT-based. It uses a central-authority model:

- The server keeps an ordered history of updates
- Clients send local updates tagged with a version
- Clients receive remote updates and rebase as needed

This is a good middle ground if we want **real-time editing** without rewriting FUTO Notes around Yjs:

- Durable storage can remain plain markdown
- The server can remain authoritative for the live session
- We only need a collaboration transport and session state, not a full CRDT storage layer

Limits:

- Not as strong as Yjs for long-lived offline merges
- Presence/cursors require extra work
- Still requires custom server/session logic; CodeMirror provides primitives, not a complete backend

## Option 3: Full Yjs Rewrite

[Yjs](https://docs.yjs.dev) is the stronger long-term collaboration system if we want real multi-user editing with robust merge behavior.

Key pieces:

- **`Y.Doc`** — the shared CRDT document
- **`Y.Text`** — collaborative text model
- **`y-codemirror.next`** — CM6 binding for `Y.Text`
- **Binary updates** — Yjs syncs compact binary updates rather than whole text files

Important point: Yjs data is **not** plain text in its native form.

- Plain text is still easy to derive from a `Y.Text` via `toString()`
- But the synced/persisted form is CRDT state and binary updates, not a human-readable `.md` file
- If Yjs becomes the real source of truth, FUTO Notes would need to export or materialize plaintext for filesystem interop

## What a Yjs Rewrite Would Entail

A real Yjs rewrite would touch almost every layer:

| Layer | Current | With Yjs |
|-------|---------|----------|
| Editor | CM6 direct `doc` state | CM6 bound to `Y.Text` via `y-codemirror.next` |
| Client storage | Plain `.md` files | Yjs state, or Yjs state plus markdown export |
| Server storage | Plain `.md` files + hashes | Yjs state and/or Yjs updates |
| Sync protocol | Full content + SHA-256 hashes | Yjs binary update exchange |
| Conflict handling | Conflict copy | Automatic character-level merge |
| Sharing | N/A | Shared room/document per note |
| Migration | None | Existing plaintext notes need Yjs bootstrapping |

This is why a Yjs rewrite should be treated as a product-level architecture decision, not a small sharing feature.

## Recommended Direction

The most conservative path is:

1. **Read-only share links**
2. **Editable share links with plain markdown persistence**
3. If real-time collaboration proves important, prototype it in the share client first

If we do want real-time soon, the next choice is:

- **Use `@codemirror/collab`** if we want a simpler, session-based live editing layer that still collapses back to plaintext cleanly
- **Use Yjs** only if we want collaboration to become a first-class storage and sync model

## What Not To Do

Avoid a hybrid design where:

- Yjs is the "real" source of truth only while a session is live
- Plain markdown/hash sync is the source of truth the rest of the time
- The owner can keep editing locally and just receive conflict copies later

That creates a confused ownership model and makes the user experience hard to reason about.

If live collaboration exists, the authority boundary needs to be explicit:

- either a single-writer/shared-session lock with plaintext persistence
- or a true collaborative document model

## Future: Permanent Shares and Multi-Source Vaults

Longer term, FUTO Notes may want a vault that can contain notes from multiple sources:

- local notes
- owned synced notes
- permanently shared notes from other users
- imported or mounted external sources

That suggests an eventual data model split between:

- canonical document identity
- source/authority for that document
- local filename/path projection

That work is out of scope for simple sharing, but this feature should avoid making future shared notes look permanently identical to "just another local file" at the data-model level.

## References

- [CodeMirror collab example](https://codemirror.net/examples/collab/)
- [CodeMirror collab API reference](https://codemirror.net/docs/ref/#collab)
- [Yjs docs](https://docs.yjs.dev)
- [Yjs document updates](https://docs.yjs.dev/api/document-updates)
- [Yjs `Y.Text`](https://docs.yjs.dev/api/shared-types/y.text)
- [y-codemirror.next](https://github.com/yjs/y-codemirror.next)

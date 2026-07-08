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

The current sync server is also deliberately single-user:

- Every collection has one owner
- Self-hosted password mode has one singleton user
- Hosted and OSS use the same sync app today
- All object/blob routes are scoped by `user_id`
- The server stores opaque encrypted blobs and must not learn note contents

The server design already points to the future shape: shared collections keep a single owner,
storage and routing follow the owner, and membership/wrapped-key metadata is added as an
authorization layer. That should be the substrate for sharing as well as collaboration.

## Build-Once Architecture

Build sharing around **owner-authoritative shared targets**, not around separate "simple link"
and "account sharing" systems.

Each shared target has:

- `authority_url` — the server that owns the target
- `owner_user_id` — the account that owns storage, billing, and routing on that server
- `collection_id` plus an optional `document_id` or scoped manifest ID
- `scope_type` — `vault`, `folder`, or `note`
- grants — capability-link grants, account/member grants, or both
- wrapped document/vault keys per grant, if the share preserves E2EE
- a local projection — optional filename/path placement in a user's app

The invariant is: **the owner's server is authoritative for the shared target**. Other servers do
not merge their own copies behind the scenes. A collaborator's app may cache shared content locally,
but writes go back to the authority that owns the target.

This gives one model for every deployment combination:

| Owner | Collaborator | How it works |
|-------|--------------|--------------|
| Self-hosted | Self-hosted | Collaborator connects to the owner's public share URL. Their own server is not in the write path unless the note is later mounted as a remote source. |
| Self-hosted | Hosted | Hosted user connects to the self-hosted owner's server. The self-hosted server must be reachable through public HTTPS, Tailscale/Funnel, or a relay. |
| Hosted | Self-hosted | Self-hosted app connects to the hosted owner's share authority. |
| Hosted | Hosted | Same authority model, but the hosted service can use account membership directly because both users exist on the same deployment. |

Do not start with server-to-server replication. Federation can be added later by teaching a vault
to mount remote authorities (`authority_url + target_id`). That is different from copying the note
into the collaborator's owned collection and hoping sync conflicts sort it out.

## Share Scope

A share can target exactly one of:

1. **Entire vault** — the grant covers the owner's collection. This is the closest match for future
   `collection_members` and gives collaborators every current and future note in that vault.
2. **Folder** — the grant covers a client-maintained set of documents under a folder projection.
   Because the sync server must not know plaintext paths, the server should not evaluate `"Work/*"`
   path rules itself. The owner client maintains an encrypted or opaque share manifest containing
   the document/object IDs currently in scope, and updates that manifest when notes move in or out
   of the folder.
3. **Specific note** — the grant covers one canonical document ID plus any attachment/object IDs
   required to render or edit that note.

The permission check should happen against the resolved target set, not only in the UI. A
collaborator with a note-scoped or folder-scoped grant must not be able to pull arbitrary objects
from the owner's collection by changing request parameters.

Folder shares need one explicit product rule: decide whether the share is **dynamic** or
**snapshot-based**.

- Dynamic folder share: a note moved into the folder becomes shared; a note moved out stops being
  shared after the owner authority processes the change.
- Snapshot folder share: the grant covers only the notes present when the share was created.

Dynamic is probably what users expect, but it requires the owner side to keep the share manifest in
lockstep with note moves, renames, deletes, and restores.

## Grants and Identity

There are two grant types worth supporting under the same model:

1. **Capability grants** — a share token/key in the URL. This is the universal path: it works for
   anonymous browser visitors, self-hosted-to-self-hosted sharing, and hosted/self-hosted mixes
   without requiring identity federation.
2. **Account grants** — a row such as `collection_members` for users known to the authority server.
   This is best for hosted-to-hosted sharing and for any self-hosted deployment that later supports
   more than one local account or OIDC.

Both grant types should resolve to the same internal permission shape: read, single-writer edit, or
live-collab edit. Both should carry enough encrypted key material for the client to decrypt the
shared document without the server seeing plaintext.

## E2EE Boundary

Sharing needs an explicit privacy choice before implementation:

- **E2EE share:** the server stores encrypted document state and encrypted/wrapped keys. The browser
  or app receives the key through the URL fragment or an account/device key grant and decrypts
  locally.
- **Server-visible share:** the owner intentionally publishes plaintext to the share service. This is
  much simpler, but it is a different privacy promise from normal sync.

The E2EE share path is the only one that matches the sync server's current threat model. It also
means a real-time protocol cannot send plaintext CodeMirror updates to the server unless the product
explicitly labels that share as server-visible.

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

The implementation order can still be incremental, but it should use the build-once substrate from
the beginning:

1. Add owner-authoritative share records and capability grants.
2. Add read-only share links backed by the same grant lookup that account sharing will use later.
3. Add editable sharing with an explicit single-writer lock and plaintext materialization back into
   the owner's note.
4. Add account grants (`collection_members`) for hosted-to-hosted and future multi-user authorities.
5. If real-time collaboration proves important, add live sessions on the same shared-target
   authority instead of creating a separate collaboration identity model.

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

Also avoid a split where hosted users get account-based sharing while self-hosted users get an
unrelated link-sharing system. Links and account membership are different grant types on the same
owner-authoritative document model.

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

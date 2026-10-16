# CRDT sync and live sharing — plan

**This is the one document for CRDT sync, live co-editing, and sharing**, in this repo and in
futo-notes-server. It was decided with Justin on 2026-10-07/08, after a live co-editing prototype
and two architecture reviews. The second review was told that no earlier decision binds this work,
and this plan follows it.

Three rules still bind: no silent data loss, the filename is the title (M2), and notes stay
readable `.md` files on disk.

## What this replaces

Deleted from `main` here, with this plan:
- `docs/adr/0003-tree-crdt-substrate.md`. It chose a tree CRDT through y-prosemirror. This plan
  picks markdown text instead (see "Why markdown text, not y-prosemirror").
- The April 2026 realtime-collab exploration notes (`future-realtime-collab.md`, since removed).

Superseded on branches that were never merged. They're kept only as evidence of what was tried:
- **App** `origin/claude/sync-system-redesign-4bbda4` (Mason, 2026-08-12):
  `docs/design/sync-redesign.md` and `crates/crdt-sync-poc`. That design keeps a server log of every
  edit, uses its own eg-walker engine, puts folder operations inside the CRDT, and identifies people
  by key pairs with no accounts. See "What we took from earlier designs."
- **App** `origin/collab-spike` (2026-04-23), and **server** `origin/collab-spike`: a TypeScript
  Yjs room spike.
- **Server** `origin/adr-scoped-architecture-direction` and `origin/spike/crdt-oplog` (2026-08):
  `docs/ARCHITECTURE-DIRECTION.md`, `docs/CRDT-SPIKE.md`, `docs/REWRITE.md`,
  `docs/adr/0003-folder-subtree-sharing.md` (a chain of per-folder keys), and
  `spike/GATE-REPORT.md`/`GATE-RECOMMENDATION.md`. The gate report's measurements are still the
  best evidence on update-log growth.
- **App** `origin/collab-proto` and **server** `origin/proto/collab`: the October 2026 prototype.
  The prototype's code paths are cited below (`collab.rs`, `collabApply.ts`, `collab.go`). They live
  on those branches, not `main`.

Updated to point here: ADR 0002's "Resolved" note and `docs/plan/milkdown-transition.md` (D2, §9).
In futo-notes-server, the hosted plan's data-model section, `CONTEXT.md`'s "Vault" entry, and
`DESIGN.md`'s v1 scope lines.

## The decisions

| | Decision |
|---|---|
| Hosted launch (v1) | Ships with **no sharing**, on the current protocol, plus the small lock-ins below |
| Merging | **Every note is a CRDT** (a document any two copies can merge automatically). No mode where only shared notes get one |
| CRDT library and shape | **yrs** (Rust Yjs). The shared document is the note's markdown text, owned by Rust. Loro is the fallback library if yrs history growth hurts |
| What syncs | **Only edits**, offline and live. The server keeps one encrypted full-state file per note plus a short tail of encrypted edits since that file. Any device can fold the tail back in |
| Folder moves, renames, deletes | **Stay outside the CRDT.** They keep today's object machinery |
| Live editing | Edits and cursors pushed to everyone viewing the note. Cursors are never stored |
| Sharing | Ships later, **live like Google Docs from its first release**. Works hosted↔hosted, hosted↔self-hosted, self-hosted↔self-hosted |
| What gets shared | A vault, a folder, or one note. Each share is **its own collection with one key**. No chain of per-folder or per-note keys |
| Adding a person | A **per-person link** carrying the server, an access token, and the key secret after `#`. No new key |
| Revoking | Remove the person's server access **and** switch the share to a new key for future edits |
| Version history | Not a v1 feature |
| Rust toolchain | Lift the 1.89 pin so yrs can move to 0.27+ |

## How it works

### One note, one CRDT

Today each note syncs as one encrypted file with a version number. When two devices both change
it, the client runs a three-way merge (`crates/futo-notes-core/src/merge.rs`), which can leave
conflict copies and has lost edits.

After this change, each note on the server has two parts.

**A full-state file** in a new frame format, v3. `note_frame.rs` already picks between v1 and v2 by a
leading byte, so v3 is an addition and old files stay readable. It holds:
- a plain header: format version, **key ID** (which key opens it), and **root ID** (which CRDT it
  is; see "Seeding" below);
- the yrs state;
- the markdown text, so the note can be read without the CRDT library. That covers a new device's
  first sync, a corrupted state, and outside tools.

**A tail of edits made since that file.** Each entry is one encrypted yrs update, usually a few
hundred bytes. Devices append to the tail and download only the entries they haven't seen. Typing
in a note never re-uploads the note.

**Folding.** Any device can merge the tail into the state and upload a new full-state file. The
server then drops the tail entries that file covers. A yrs state already is a compacted snapshot,
so folding needs no coordination: any device may fold at any time, and folding twice does no harm.
Fold when the tail grows past roughly the size of the state, and when a note closes.

Merges never fail, so text conflict copies go away. `conflict_resolution/` shrinks to the seeding
fallback below.

This is not a permanent log of every edit. Earlier designs kept one (Mason's design and the server
`CRDT-SPIKE.md`), and most of their open problems came from it: which device makes snapshots, when
old entries may be deleted, and what a newcomer starts syncing from. The tail here only ever covers
the gap since the last fold.

**Server change:** an "append an edit" route, a "read the tail since N" route, and a fold that
replaces the state and trims the tail. That means self-hosted servers need an update before CRDT
sync, and clients need the minimum-version check (see "Before the hosted launch").

### Seeding: a note becomes a CRDT exactly once

If two devices each turn the same old v2 note into a CRDT, the two histories share nothing, and
merging them duplicates the whole note. The rule:
- The first v3 upload wins the version check, and its root ID becomes the note's.
- A device whose upload is refused, and which finds a v3 note with a **different** root ID, never
  merges its own CRDT. It runs the three-way merge once (base = its last-synced text) and applies
  the result as ordinary edits on top of the winner's state.

Before this ships, the prototype's fuzz test (`collab_fuzz.rs` on `collab-proto`) gets extended to
cover seeding races.

### The `.md` file on disk

The CRDT is what syncs, and the `.md` is written out from it. An outside edit to the file (another
editor, the CLI, a sync tool) is diffed back into the CRDT as an ordinary edit, the same way the
prototype handles editor text (`Replica::sync` in `collab.rs`). The desktop file watcher
(`apps/tauri/src-tauri/src/filesystem_watcher.rs`) already delivers the events.

The editor re-spells markdown when it saves (ADR 0002). That re-spelling is diffed against the
editor's own rendering of the shared text (the prototype's `collabRepresent`), so it never reaches
other devices as an edit.

**Add a mass-deletion guard first.** An outside edit that empties or nearly empties a note, or a
vault folder that disappears, asks before it becomes a deletion that every other device merges.

Each note's CRDT state is cached locally beside the sync state, and loaded only for notes that are
open or syncing. If the cache is lost, it rebuilds from the server plus the `.md`.

### Folder moves, renames, deletes, images

These stay object operations: create, rename, move, delete, rename pairing, collision handling, and
sort order. A rename is never a text edit, which protects "the filename is the title." Images stay
whole encrypted objects with unique names. The prototype's encrypted image path
(`collab_images.rs`) carries over.

### Live editing

While someone else has the note open, each edit is appended to the tail and pushed straight to them
over the existing server-sent event stream. That's the same tail as offline sync, just faster.
Cursors and selections travel the same stream, encrypted with the share's key, and are never
stored. The prototype's server (`cmd/server/collab.go` on `proto/collab`) already does both, keyed
by a shared token. The real version is keyed by note and by session or link token.

The editor applies remote edits as small changes, so your caret and undo history stay put
(`collabApply.ts`). Long term, the editor should send its actual edits rather than whole-text
snapshots. That fixes caret placement near links, and the leftover merge errors the fuzz harness
documents.

**Known limit, accepted:** two people editing the same table row or list item at the same moment
can produce broken markdown. The words survive. This goes in `docs/spec/` when the feature ships.

On mobile, live editing needs a new editor-bridge message to apply remote edits mid-typing, in both
native apps (M10). That is a `BRIDGE_VERSION` change: ask first.

### Sharing

A share lives on **the sharer's server**. The recipient's app connects straight to that server for
that one share. Nobody needs an account on anyone else's server.

A share is its own collection with one key. It shows up in the recipient's vault as a folder, and an
encrypted list in the owner's home collection records where each share is mounted. Sharing a vault,
a folder, or a note is the same mechanism. Moving a note into or out of a share re-encrypts that one
note under the destination's key, as a delete plus a create. **Shares inside shares are not allowed
in the first release.**

### Adding people

Each person gets their own link:

```
https://<sharer's server>/s/<share id>?t=<access token>#<key secret>
```

- The **access token** goes to the server and lets that person read and write that one share.
- The **key secret** sits after `#`, which browsers never send to a server. It unlocks a copy of the
  share's key that the server stores but can't open.
- **The first device to open a link claims it**, so a forwarded link stops working.

**Adding someone never makes a new key and never re-encrypts anything.** It's one new access token
and one new wrapped copy of the existing key. That's what makes adding people cheap enough to feel
like Google Docs. Because the key travels in the link, sharing needs no account key pairs, no key
lookup, and no safety numbers.

Later, for hosted↔hosted only, "type a username" can deliver the invite to the person's account
instead of a link. That needs account public keys, and trust that FUTO's server hands out the real
ones. Not in the first release. "Anyone with the link" is not offered, because one person couldn't
then be revoked alone.

### Revoking

Revoking someone does two things:
1. **The server deletes that person's access token.**
2. **The share switches to a new key.** The sharer's app makes it and encrypts a copy under each
   remaining person's link secret. The server stores those copies and can't open them. Members pick
   theirs up on their next connect. The next fold of each note uses the new key, so nothing is
   re-encrypted in a separate pass.

Members' apps keep old keys, and each file names its key, so a missed key change can't lock anyone
out of existing notes. The promise to users: **once you revoke someone, they get no further
updates.** Anything they already saw stays theirs, which no encrypted app can undo.

### What sharing needs beyond CRDT sync

- **The client handles collections on more than one server.** Today it assumes one collection on one
  server, and that assumption runs through `futo-notes-sync`. This is the largest single piece of
  sharing work.
- **Self-hosted servers learn guest access**: a link token scoped to one collection. Self-hosted is
  single-user by design today (server `DESIGN.md`). Sharing needs a minimum server version.
- **The recipient's own sync skips mounted shares**, so someone else's notes never upload to the
  recipient's own server.
- **Reachability.** The sharer's server has to be reachable by the recipient. A self-hosted server on
  a home network or Tailscale can't share with outsiders, and the share screen says so.

What the server learns: which encrypted objects belong to which share, how many people hold links,
and when each person edits. It never learns names, paths, or content. The server's `DESIGN.md`
threat model gets amended in the change that ships sharing.

## Why markdown text, not y-prosemirror

| | Markdown text in yrs (chosen) | y-prosemirror (the editor's document tree) |
|---|---|---|
| Two people editing one table or list | Can produce broken markdown | Stays valid |
| Who can read the shared doc | Rust: CLI, MCP, search, sync with no editor open | Only code that knows Milkdown's schema. Rust would need a copy of its serializer (M6) |
| Faithfulness to the file | Exact markdown bytes | Every load and save goes through the editor's spelling |
| Editor schema changes | Don't matter | Every stored note is tied to the schema; changes become data migrations |
| Edits made outside the app | Diffed in like keystrokes | Need a markdown→tree diff nobody has built |
| Mobile | Rust owns the doc; the bridge carries markdown | The doc lives in the WebView; the bridge carries Yjs updates |

The broken-table risk is the cost, accepted above.

## What we took from earlier designs

From Mason's design: seeding a note exactly once with one last three-way merge, the mass-deletion
guard, a link that carries the key, connecting to the sharer's server, guests as grants rather than
accounts, and cursors relayed but never stored. Worth lifting later: its sync-timing rules (how
often to sync when a peer is viewing, online, or absent), its "members channel" for offering new
shares to people you already share with, and its rule that lands two people's offline additions to
the same line on separate lines.

Dropped, and why:
- **Its own CRDT engine, with folder operations inside it.** We would own a merge engine forever, and
  its folder half was the one unprototyped, research-grade piece.
- **A permanent server log.** It caused most of that design's open problems. A yrs state already
  merges, so the log isn't needed.
- **Passwordless key-pair identity.** Hosted already built accounts, the vault password, a recovery
  key, and QR pairing, and billing needs accounts.
- **A chain of folder and note keys.** Revocation means rotating every key below the shared folder,
  which that design called its least-proven mechanism.

## Before the hosted launch: lock these in

These are small and keep every later step additive:
1. **Minimum client version** in the server's capability response. Without it, an old client that
   meets a v3 note stops advancing its sync cursor and never says why (`docs/spec/sync.md`, "A failed
   blob download never advances the cursor").
2. **Frame v3's header layout**: version byte, then key ID, then root ID. Written down, even if
   unbuilt.
3. **More than one collection per account** stays possible: no hard one-per-account rule in the
   schema.
4. **Nothing new depends on the 365-day retention** of replaced files. They're kept today as merge
   bases, and CRDT merging doesn't need them. Shorten retention once CRDT sync has proven itself,
   not before: those copies are also the safety net if a bug eats a note.

## Order of work

0. **Toolchain.** Lift the Rust 1.89 pin and move to yrs 0.27+. Its own commit: the rust-toolchain
   file, CI images, and `just prepush` across desktop and both mobile apps. This also fixes the
   cursor-position bug the prototype works around with a second, UTF-16 copy (`collab_presence.rs`).
1. **Launch lock-ins** above, in the hosted work.
2. **CRDT sync for every note.** Frame v3, the edit tail and folding (server and client), the
   seeding rule, `.md` diff-in with the mass-deletion guard, and fuzz coverage. Internal builds
   first.
3. **Live editing** between one person's own devices: push on the event stream, plus cursors.
   Desktop first, then the mobile bridge change.
4. **Sharing**: more than one server per client, share collections, per-person links with
   claim-on-open, guest access on servers, the mount list, and revoke with a key change. Ships
   together with step 3 on every platform, so sharing is live from its first release.
5. **Shorter file retention**, once step 2 has run long enough to trust.

## Open questions

- **CRDT state growth on heavily edited notes.** Not measured. Measure on real vaults in step 2, and
  switch to Loro if it's bad.
- **Who can share a share**: can a recipient make more links, or only the owner? Not decided.
- **Read-only links.** Not decided. The server would have to refuse writes for a token, because the
  key alone can't enforce it.
- **What a recipient keeps after being revoked**: does the mounted folder stay as a local copy or
  disappear? Not decided. "No silent data loss" suggests it stays.

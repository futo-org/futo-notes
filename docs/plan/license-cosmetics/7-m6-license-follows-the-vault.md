## 7. M6 — the license follows the vault (DEFERRED by D28; ask-first; own MR)

**Deferred 2026-10-16 (D28).** M6 is not scheduled and M7 does not wait for it. Everything below is kept for when it is picked up: the feasibility note, the decided carrier (Q3: the hidden engine slot), and the rules. The "REQUIRED" wording below is historical (D16, superseded). Without M6 a license is per device, as today. A store purchase reaches the user's other devices **on the same store** through that store's Restore (Apple ID across iPhone and iPad; Google account across Android Play installs). It does **not** reach other platforms: an App Store purchase does not license Android or desktop, and a Play purchase does not license iOS or desktop. A website/FUTOpay key still works anywhere it is entered. **D29 (same day):** a store purchase is redeemed for a FUTOpay key, so M6 only ever carries one proof kind (the pair) and the three-kind text below is historical; § 7c.3 "M6 gets smaller" is the current shape. A store buyer reaches another platform today by revealing the key on the card and entering it there, as with a website key. **2026-10-19:** store purchases are deferred (§ 7b, § 7c), so every statement above about a store purchase is part of that record; a license today is a website key, per device.

Problem: the license is entered per device (license.md Gap "License sync"). Once a license
includes something visible, a second phone that is synced but Unlicensed reads as broken. Since
D15/D16 this is **required**: an App Store purchase proof is bound to an Apple account and is
otherwise useless on the buyer's Android phone or desktop. M6 carries "the license proof", which
is either the FUTOpay pair or an App Store signed transaction (a JWS string, a few KB). The
carrier is the one the Feasibility note below recommends (option (a): a dedicated engine slot at
a reserved non-note path); **confirming it is still @justin's call (§ 9, Q3)**, and M6 does not
start before that OK. Additions for the other proofs (three kinds now: FUTOpay pair, Apple JWS, Google signed purchase; D17-D19). **Carrier confirmed 2026-10-16: the hidden engine slot, never a file.** With refunds out of scope (D18) any valid proof counts, so duplicate copies simply keep one, and the one rule that remains is that a **Remove license tombstone wins over an offline device** that still holds the proof. The slot may hold one proof per kind; a device never drops its own valid proof because a pulled one fails to verify there (e.g. a Sandbox proof on a production store install). The refund-driven parts below ("no revocation signal", tombstone-for-refund) are void:

- The object holds a small tagged value (`{"kind":"futopay-pair",...}` or
  `{"kind":"apple-jws","jws":"..."}`). One object, one proof: when a device holds both, publish
  the one `evaluate` ranks Licensed, preferring the FUTOpay pair (portable, carries `issued_at`).
- A pulled proof of either kind goes to Rust `evaluate` as if typed or bought; nothing is trusted
  for arriving by sync. A synced Apple proof verifies on **Android and desktop** too: it is pure
  Rust, offline, no Apple call. On Android `play` that is allowed (Google lets any app be
  consumption-only: access bought elsewhere may be honored; it just cannot be sold there).
- A synced Apple proof gives **no revocation signal off iOS**. Only an iOS device that sees
  StoreKit report a revocation removes the proof and syncs the tombstone (the tombstone-wins rule, § 9 Q9); Android and desktop keep honoring the stored JWS until then.
- Self-hosted sync: unchanged, the object is an opaque encrypted blob on any server.
- Users without sync keep a per-device license. State this in the spec; do not paper over it.

Proposed shape, to be confirmed before any code:

- The stored pair (key + activation) travels inside the E2EE vault as one small encrypted
  object, the same way a note's bytes do, so the server keeps seeing opaque blobs and the
  hosted and self-hosted servers need no change. **First task is to establish whether the
  sync crate can carry a non-note object today** (the vault model is note-shaped:
  `sync/vault.rs`, `sync/encrypted_note.rs`). If it cannot, the options are (a) a reserved,
  hidden vault path the store never lists as a note, or (b) a new object kind in the
  protocol, which also touches the server repo. Write the answer into this section before
  choosing; (a) is the preference if the store's listing and the editor can be kept from
  ever seeing it.
- Entering a key on any device publishes the pair on the next push. A pull that delivers a
  pair hands it to Rust `evaluate` exactly as a typed key would; the dev/prod split holds
  (a production pair in a `.dev` build verifies as Unlicensed, correctly). Nothing is trusted
  because it arrived by sync; verification is the same RSA check.
- **Remove license** on any device removes the synced copy too: one vault, one license.
  Last-writer-wins on the object; a conflict between two different valid pairs keeps the one
  with the later `issued_at`, else the later write.
- A device that receives a pair runs the M5 landing only if it is in the foreground and in
  Settings; otherwise just the toast. Never present UI from a background pull.
- Zero background network stays true for the license module: the pair arrives through the
  sync cycle the user already configured; the license crate still makes no call of its own.
- Spec: license.md Gap closes; sync.md gains a "What travels besides notes" line; the
  conflict rule gets a line in § Conflict & data safety.

Verification: the cross-platform sync harness (`tests/cross-platform-sync.mjs`, `tests/sync-integration.mjs`), two emulators/simulators, a
desktop + phone pair; `just test-rust`.

### Feasibility (2026-10-15)

Read-only research; no code changed. Recommendation only. Justin's call: M6 is not now
(own MR later), so this records what the later MR must do.

**Can the sync crate carry a non-note object today? No, not without engine changes. The
server can carry it; the client engine cannot.**

- The server is already kind-agnostic. An object is `id, version, change_seq, deleted,
  blob_key, size_bytes, timestamps` (`futo-notes-server/internal/objects/objects.go:25`;
  `docs/Rewriting the server in Go.md` § objects). There is no path or kind column: the path
  lives only inside the encrypted blob. The server validates only blob size (100 MiB,
  `internal/config/config.go:104`) and batch size (32 MiB). A listing exposes only opaque ids
  and sizes, so a hidden path leaks nothing, and self-hosted servers need no change for (a).
- The client engine is file-shaped end to end. The blob frame is `pack_note_v2(path, content)`
  (`futo-notes-core/src/e2ee/note_frame.rs:11`). A pulled object is classified by path
  (`classify_incoming_sync_path`, `futo-notes-core/src/files/paths.rs:89`); anything that is
  not `.md` or an image is `Ignore`d silently (`paths.rs:95`; `sync/pull/apply_remote.rs:50-62`:
  no failure, nothing written, nothing mapped). Push enumerates the disk (`sync/vault.rs:100`
  skips every dot entry, `:130` skips non-syncable names), and deletion only considers
  `is_syncable_filename` names (`sync/push/delete_local.rs:73`). So a non-note object is
  never pushed, never tracked in `object_map` (keyed by file name, `checkpoint.rs:41`), and
  never deleted by today's engine. Create, update, tombstone and conflict handling all hang
  off that map and the disk scan.
- Nothing else non-note travels today except images (same note frame, base64; `sync.md`
  § Embedded images). Folders are implied by note paths; settings, non-image attachments and
  folder metadata do not sync. `.e2ee-state.json` is a vault dotfile that is per-device state
  and is not synced.

**What the rest of the app would see.** Dot-prefixed entries are already invisible: store
listing (`futo-notes-store/src/vault.rs:333`, `:401`) and sync scan (`sync/vault.rs:100`), and
search/index/editor read the store listing. I found no iOS/Android/desktop directory walk that
bypasses the Rust store. A reserved path that is never a file on disk cannot be listed by any
of them. (Not verified at runtime.)

**Option (a): reserved hidden path, carried as a side channel rather than a file.**
- Path: a non-syncable extension, e.g. `.futo/license.json`, in the normal note frame. It must
  NOT end in `.md` or an image extension: an old client would `Accept` that and write it to disk.
- Do not materialise it as a file. The push scan skips it and delete-detection would read it as
  "missing locally". Keep it out of `object_map` and add one dedicated slot to `ConnectedState`
  (e.g. `license_object: Option<ObjectState>`; plain serde, `checkpoint.rs:35`, no
  `deny_unknown_fields`, so an older client reading the state file ignores it), with a hook in
  push (publish when the local pair changed or was removed) and in pull (recognise the reserved
  path before `classify_incoming_sync_path`, hand the pair up through the summary, write no
  file). This is a real sync-engine change: push-first ordering applies (publish after notes in
  the same cycle) and AGENTS.md §11.6 (sync payload) makes it ask-first.
- Listings to filter: none in store/search/editor if no file exists. The only new filtering is
  inside the engine (pull classifier, object-map pruning, `delete_missing`).
- Conflict/LWW: the server gives per-object optimistic versions (stale PUT returns 409) but
  does NOT enforce path uniqueness. Two devices entering a key offline each POST a new object
  at the reserved path, i.e. two objects. The existing path-collision rule
  (`sync/collision_resolution.rs:28`: lowest object id wins, loser becomes a conflict copy) is
  note-shaped and must not be reused. The license needs its own rule (later `issued_at`, else
  later write, as § 7 says) and must tombstone the losing duplicate; a 409 re-reads the remote
  pair and re-applies the same rule. New merge code in a crate that merits `/slow-review`.
- Deletion: "Remove license removes the synced copy" is a normal DELETE of that one object
  (tombstone). Peers pull it and drop their pair. Gap: a device offline during Remove keeps its
  pair and would republish it on its next push, resurrecting the license. The rule needs
  tombstone-wins (never republish a pair whose object was tombstoned after it was last synced),
  otherwise "one vault, one license" does not hold. Decide this explicitly.
- E2EE: unchanged. AES-GCM under the vault key like every note; the server sees an opaque blob
  of a few hundred bytes. Every synced device holds the vault key, so any of them can read the
  pair; that is inherent and matches "one vault, one license".
- Self-hosted: works on any server that accepts a normal object; no change to
  `scripts/sync-server-pin.json`.
- Mixed-version clients: an OLD client downloads and decrypts the object, then `Ignore`s it
  (`IGNORE_NOT_A_NOTE`): no failure, no journal line, no file, no map entry. It never publishes
  or removes it, so old devices simply stay per-device licensed. Needs a mixed-version run to
  confirm (CI never pins that pairing).

**Option (b): a new object kind.**
- Server `kind` column: migrations for both Postgres and SQLite
  (`internal/db/migrations/{postgres,sqlite}`), API/OpenAPI and listing changes, a server
  release and a pin bump. Self-hosters on older servers silently lose the feature, and the
  hosted deploy must be coordinated. The server never interprets content, so it buys nothing.
- Client-only variant (a new frame byte, e.g. `0x03`): worse for old clients. `unpack_note`
  returns `UnknownFrame` (`note_frame.rs:41`), which `decrypt_bytes` turns into
  `FailureKind::Decrypt` (`encrypted_note.rs:53`): a loud pull failure on every old device that
  may also hold the pull cursor back (`pull/mod.rs:41`). The cursor stall is unverified; treat
  it as a risk to test.

**Risks.** (1) The engine change is real even for (a): the crate has no notion of a non-file
object. (2) The duplicate-object race and offline-Remove resurrection need the explicit rules
above. (3) A `.dev` and a prod build sharing one vault would publish/remove each other's pair;
decide whether a build publishes a pair it cannot verify. A prod pair in a `.dev` build is
simply Unlicensed, as § 7 says. (4) Spec debt: sync.md "What travels besides notes", the
conflict-rule line, license.md Gap, a `tests/cross-platform-sync.mjs` scenario, and
`/sync-adversarial`.

**Recommendation (not a decision).** When M6 is picked up: option (a), a reserved non-`.md`
path (`.futo/license.json`) carried by a dedicated engine slot rather than a vault file. It
leaves the server and self-hosted compatibility untouched, old clients ignore it silently, and
nothing in store/search/editor can see it because no file exists. Reject (b): it needs a server
release for something the server cannot interpret, and the in-frame variant breaks old
clients loudly. Also reject a reserved hidden *file* in the vault: the scan skips it and
delete-detection would treat it as gone. Open for the later MR: the offline-Remove rule.

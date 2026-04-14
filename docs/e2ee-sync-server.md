# E2EE Sync Server

Stonefruit's hosted sync service. The server stores and serves encrypted blobs. It cannot read filenames, content, or metadata. If a user loses their password, their data is unrecoverable.

## Context

The current sync server (`crates/stonefruit-server/`) is a self-hosted Rust/Axum service that sees everything: filenames, content, hashes, timestamps. It performs server-side three-way merge, full-text search, and semantic embedding. That design is fine for a box you own, but it's wrong for a hosted service where we hold other people's data.

The E2EE server is a separate service. It's the primary sync offering going forward. People can still self-host the existing server if they want plaintext access to their files on their own hardware.

## Architecture

```
Client (Tauri / mobile)              E2EE Sync Server
┌───────────────────────┐            ┌──────────────────────┐
│                       │            │                      │
│  password             │            │  Sees:               │
│    ├→ auth_key ───────┼── HTTPS ──→│    auth_key (hashed) │
│    │  (Argon2id,      │            │    opaque_id         │
│    │   auth_salt)     │            │    encrypted blob    │
│    │                  │            │    blob size         │
│    └→ vault_key       │            │    version number    │
│       (Argon2id,      │            │                      │
│        vault_salt)    │            │  Cannot see:         │
│       ├→ file_key     │            │    password          │
│       └→ name_key     │            │    vault_key         │
│                       │            │    filenames          │
│  Encrypt locally      │            │    content           │
│  Merge locally        │            │    file types        │
│  Search locally       │            │                      │
└───────────────────────┘            └──────────────────────┘
```

## Encryption

### Key derivation

One password. Two derived keys. The server never sees the password or the vault key.

```
password
  ├─→ Argon2id(password, auth_salt)  → auth_key (32 bytes)
  │     Sent to server for authentication.
  │     Server stores Argon2id(auth_key) — double-hashed.
  │
  └─→ Argon2id(password, vault_salt) → vault_key (32 bytes)
        Never leaves the device.
        ├─→ HKDF(vault_key, "file-encryption") → file_key
        └─→ HKDF(vault_key, "name-encryption")  → name_key
```

`auth_salt` and `vault_salt` are random 16-byte values generated at account registration and stored server-side (they're not secret — salts prevent rainbow tables). The client fetches them at login time before deriving keys.

### Per-file encryption

```
nonce = random 24 bytes
plaintext = filename_length (4 bytes, little-endian)
          ‖ filename (UTF-8)
          ‖ content (raw bytes — works for .md and images)
ciphertext = XChaCha20-Poly1305(file_key, nonce, plaintext)
```

The filename is packed inside the encrypted blob. The server identifies files by `opaque_id` — a random UUID the client generates when a file is first created. The server never sees the filename.

### Algorithm choices

- **Argon2id** for password → key derivation (memory-hard, resists GPU attacks)
- **XChaCha20-Poly1305** for file encryption (24-byte nonce eliminates collision risk, no padding, authenticated)
- **HKDF-SHA256** for vault_key → file_key / name_key derivation

## Server

### Stack

TypeScript, Hono, better-sqlite3. The Hono server from `apps/server/` at commit `5e7bd33` is the starting point — it has working Hono scaffolding, CORS, better-sqlite3 with WAL mode and migrations, Argon2 password hashing, token-based session management, and auth middleware.

### Schema

```sql
accounts (
  id TEXT PRIMARY KEY,           -- random UUID
  email TEXT UNIQUE NOT NULL,
  auth_key_hash TEXT NOT NULL,   -- Argon2id(auth_key) — double-hashed
  auth_salt BLOB NOT NULL,       -- 16 bytes, sent to client pre-login
  vault_salt BLOB NOT NULL,      -- 16 bytes, sent to client pre-login
  stripe_customer_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)

sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  device_info TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)

vaults (
  id TEXT PRIMARY KEY,           -- random UUID
  account_id TEXT NOT NULL REFERENCES accounts(id),
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)

vault_items (
  vault_id TEXT NOT NULL REFERENCES vaults(id),
  opaque_id TEXT NOT NULL,       -- client-generated UUID, meaningless to server
  encrypted_blob BLOB NOT NULL,
  nonce BLOB NOT NULL,           -- 24 bytes
  version INTEGER NOT NULL,      -- server-assigned, monotonically increasing
  size INTEGER NOT NULL,         -- byte length of encrypted_blob (for billing)
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (vault_id, opaque_id)
)

vault_tombstones (
  vault_id TEXT NOT NULL REFERENCES vaults(id),
  opaque_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (vault_id, opaque_id)
)

device_cursors (
  vault_id TEXT NOT NULL REFERENCES vaults(id),
  device_id TEXT NOT NULL,
  last_version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (vault_id, device_id)
)

vault_usage (
  vault_id TEXT PRIMARY KEY REFERENCES vaults(id),
  total_bytes INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
)
```

### Endpoints

#### Auth

```
POST /account/register
  Request:  { email, auth_key }
  Server:   generates auth_salt + vault_salt, stores Argon2id(auth_key)
  Response: { account_id, vault_id, auth_salt, vault_salt }

POST /account/salts
  Request:  { email }
  Response: { auth_salt, vault_salt }
  Note:     public endpoint — salts aren't secret. Client needs them
            before it can derive auth_key to log in.

POST /account/login
  Request:  { email, auth_key, device_info? }
  Response: { token, account_id, vault_id }

POST /account/logout
  Authed. Revokes the session token.
```

Login flow from the client's perspective:
1. User enters email + password
2. Client calls `/account/salts` to get `auth_salt` and `vault_salt`
3. Client derives `auth_key = Argon2id(password, auth_salt)` locally
4. Client derives `vault_key = Argon2id(password, vault_salt)` locally
5. Client calls `/account/login` with `auth_key` (never the password)
6. Client stores `vault_key` in memory (or OS keychain) for encryption

Registration is the same, except the client calls `/account/register` and the server generates the salts.

#### Sync

```
POST /sync
  Authed.
  Request: {
    vault_id,
    device_id,
    last_version,                  -- "give me everything after this"
    upserts: [
      { opaque_id, encrypted_blob, nonce }
    ],
    deletes: [ opaque_id ]
  }
  Response: {
    remote_upserts: [
      { opaque_id, encrypted_blob, nonce, version }
    ],
    remote_deletes: [ opaque_id ],
    version                        -- new cursor for client to store
  }

POST /sync/check
  Authed. Lightweight poll.
  Request:  { vault_id, last_version }
  Response: { has_changes, version }

GET /vault/:id/item/:opaque_id
  Authed. Single-item fetch for large blobs (images) on demand.
  Response: { encrypted_blob, nonce, version }
```

#### Health

```
GET /health
  Response: { status: "ok" }
```

### What the server does NOT do

- No filename storage or indexing
- No content hashing (hashes are deterministic — they leak file identity)
- No three-way merge (can't merge what you can't read)
- No full-text search or embeddings
- No conflict resolution
- No file-system storage (blobs live in SQLite, not on disk)

## Client changes

### New sync service

A new sync adapter that replaces `syncServiceV2.ts`. It:

1. Scans local files and detects changes (same as today)
2. Encrypts changed files with `file_key` before upload
3. Calls `POST /sync` with encrypted blobs
4. Decrypts received blobs and writes to local filesystem
5. Manages the opaque ID map (filename ↔ random UUID)

### Local state

```json
// .e2ee-state.json (in notes directory)
{
  "vault_id": "...",
  "device_id": "...",
  "last_version": 42,
  "opaque_id_map": {
    "grocery list.md": "a1b2c3d4-...",
    "images/photo.png": "e5f6a7b8-..."
  },
  "local_hashes": {
    "a1b2c3d4-...": "sha256-of-plaintext"
  }
}
```

The `opaque_id_map` is the critical new piece. It maps real filenames to server-side random IDs. When a new device syncs for the first time, it has no map — it pulls all blobs, decrypts them, and rebuilds the map from the filenames embedded in each blob.

`vault_key` is held in memory during the session or in the OS keychain. It is never written to this file.

### Conflict resolution

Moves entirely to the client. When both the local device and the server have changes to the same `opaque_id`:

1. Client decrypts both versions
2. Attempts three-way merge using existing `merge.rs` logic via FFI (the ancestor is the last-synced version, which the client keeps locally)
3. If merge succeeds: re-encrypts merged result, pushes back
4. If merge fails: creates a conflict copy locally (same naming as today: `note (conflict 2026-04-08).md`)

### Search

Client-side only. MiniSearch already exists in the client for offline search. Server-side search (BM25 + vector) does not apply — the server can't read content.

## Billing

Stripe usage-based metering.

- On each sync, the server updates `vault_usage.total_bytes` based on blob sizes
- Stripe usage record: `vault_id`, `total_bytes`, `timestamp`
- Free tier: 100 MB. Paid: $3/mo for 5 GB, metered beyond.
- Server checks quota before accepting upserts. Over-quota syncs are rejected with a 402 and the client shows an upgrade prompt.

## Phases

### Phase 1: Core sync loop

Get encrypted sync working end-to-end across two devices.

**Server:**
- New Hono project based on `apps/server/` at `5e7bd33`
- Strip out: sync engine, notes DB, search, plugins, dashboard, SSE events
- New schema: accounts, vaults, vault_items, vault_tombstones, device_cursors
- New routes: `/account/register`, `/account/salts`, `/account/login`, `/account/logout`
- New route: `POST /sync` (store/serve opaque blobs with version tracking)
- New route: `POST /sync/check`
- Modify auth middleware to be account-scoped (multi-tenant)

**Client:**
- Crypto module: key derivation (Argon2id), encrypt/decrypt (XChaCha20-Poly1305), HKDF
- New sync service: encrypt before send, decrypt after receive, opaque ID map management
- Registration + login flow with client-side KDF
- Device onboarding: first-sync pulls all blobs, decrypts, rebuilds opaque ID map
- Conflict resolution: client-side merge using existing infrastructure

### Phase 2: Billing

- Stripe integration: customer creation on register, usage metering on sync
- Quota enforcement: reject over-quota upserts with 402
- Client: upgrade prompt when quota exceeded

### Phase 3: Polish

- Three-way merge on client (wiring up `merge.rs` for real conflict resolution instead of conflict copies)
- Password change flow (re-derive keys, re-encrypt vault — expensive but necessary)
- Account deletion (purge all blobs, Stripe cancellation)
- Rate limiting, abuse prevention
- Any other operational concerns before public launch

## Recovery policy

There is no recovery mechanism. The vault key is derived from the user's password. The server never sees the password or the vault key. If the user forgets their password, their data is permanently lost. This is a deliberate design choice — it's the only way to guarantee zero knowledge.

The client should make this clear at registration and periodically remind users.

## Starting point

The Hono server at commit `5e7bd33` in `apps/server/` has:

| Module | Status | Notes |
|---|---|---|
| `app.ts` | Reuse | Hono scaffold, CORS, error handling |
| `db/index.ts` | Reuse | better-sqlite3, WAL, migrations |
| `db/schema.ts` | Replace | New E2EE schema |
| `auth/password.ts` | Modify | Argon2 stays, but input is auth_key not password |
| `auth/token.ts` | Reuse | Token hashing |
| `db/sessions.ts` | Reuse | Session CRUD |
| `middleware/auth.ts` | Modify | Add account_id scoping |
| `config.ts` | Reuse | Config loading |
| `logger.ts` | Reuse | Logging |
| `index.ts` | Modify | Strip search/plugin init |
| `routes/login.ts` | Modify | Client sends auth_key, not password |
| `routes/setup.ts` | Replace | Becomes `/account/register` |
| `routes/sync.ts` | Replace | New opaque blob protocol |
| `routes/health.ts` | Reuse | As-is |
| `sync/engine.ts` | Delete | Server can't read content |
| `db/notes.ts` | Delete | No plaintext note metadata |
| `search/*` | Delete | Server can't search |
| `plugins/*` | Delete | Plugins read plaintext |
| `routes/dashboard.ts` | Delete | Nothing to display |
| `events.ts` | Simplify | Just "new version" pings |

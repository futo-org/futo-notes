# E2EE Migration TODO

Comprehensive list of remaining work after removing the Rust server and switching to E2EE sync.

---

## Client Repo (stonefruit)

### CI Pipeline (blocks releases)

- [x] Remove `test:server` job from `.gitlab-ci.yml` — tries to `cargo test -p stonefruit-server` which no longer exists
- [x] Remove `test:server:smoke` job — builds Docker image from deleted `crates/stonefruit-server/Dockerfile`
- [x] Remove `docker:publish` and `docker:verify` jobs — publish pipeline for the old Rust server image
- [x] Update `test:cross-platform` job — remove `cargo build -p stonefruit-server` line, update to use E2EE server
- [x] Remove server job dependencies from the release job (`needs:` block)

### Dead Code Cleanup

- [ ] **appState.ts** — remove V2-only fields from `AppState` interface: `serverUrl`, `authToken`, `lastServerVersion`, `fileHashes`, `hashCache`, `dirtyUpserts`, `dirtyDeletes`, `graphLayout`, `ServerGraphLayout`
- [ ] **appState.ts** — remove V2 facade functions: `loadV2SyncState()`, `saveV2SyncState()`, `clearV2SyncState()`, `V2SyncState` interface
- [x] **appState.ts** — remove `AppPreferences` sync facade (maps V2 serverUrl/token) or update it to reflect E2EE fields
- [ ] **rustCore.ts** — remove `prepareSyncPayloadV2()` and all `RustV2Sync*` types if no longer called (check if `syncServiceE2ee.ts` still uses `applySyncDeltaV2`)
- [ ] **platform/types.ts** — remove dead `NativeCapabilities` supersearch methods (`supersearchDownload`, `supersearchHasArtifacts`, `supersearchQuery`, `supersearchNoteVector`, `supersearchAllNoteVectors`)
- [ ] **platform/tauri.ts** — remove supersearch implementations (lines ~295-312)
- [ ] **autoSyncV2.ts** — rename file to `autoSync.ts` (or `autoSyncE2ee.ts`) to reflect it no longer delegates to V2
- [x] **package.json** — remove stub `server:dev` and `server:test` scripts entirely
- [ ] **GraphCanvas.svelte** — currently dead code (graph panel is disabled). Remove or keep for future local graph work

### Test Infrastructure

- [x] **tests/lib/sync-test-server.mjs** — tries to start `target/debug/stonefruit-server` binary. Update to start the E2EE server (Node process) instead
- [x] **tests/cross-platform-sync.mjs** — update setup instructions and server binary references for E2EE server
- [x] **tests/verify-sync.mjs** — check if this still works or needs E2EE update
- [x] Write E2EE-specific sync integration tests (connect, push, pull; conflict and disconnect still need deeper coverage)

### Documentation

- [x] **README.md** — remove "Semantic Search (V2 Server)" section and Ollama env var docs. Add E2EE server setup instructions
- [x] **AGENTS.md** — remove references to: `authFetch.ts`, `POST /sync`, server-side search/graph, `just server-*` commands, `just cli-*` commands, `crates/stonefruit-server/`, `apps/cli/`
- [x] **src/AGENTS.md** — remove references to: `syncServiceV2.ts`, `authFetch.ts`, `supersearch/` module, server search/graph
- [x] **apps/tauri/AGENTS.md** — update sync testing instructions for E2EE
- [x] **docs/e2e-demo-checklist.md** — update for E2EE server instead of Rust server
- [ ] **docs/V2-MASTERPLAN.md** — mark as historical or archive
- [ ] **docs/tauri-rust-to-ts-migration-ledger.md** — close out or archive (migration is now moot — V2 is gone)

### E2EE Sync Feature Gaps

- [x] **Hash-based change detection** — currently re-uploads all files every sync. Store content hashes in `e2eeObjectMap` and skip unchanged files
- [x] **Multi-device vault unlock** — server stores password-wrapped vault key material so another logged-in device can unlock the same vault without device-to-device transfer
- [ ] **Conflict handling** — currently ignores 409 conflicts. Implement: download server version, create conflict copy (`"note (conflict 2026-04-14).md"`), let user resolve
- [ ] **Three-way merge** — `stonefruit-core` has merge support. Wire it up for compatible (non-overlapping) edits before falling back to conflict copies
- [ ] **Rename detection** — when a file is renamed locally, detect same-hash delete+create and update the object instead of creating a new one
- [x] **Incremental push** — only upload files that changed since last sync (track last-sync hashes or mtimes)
- [ ] **Password-in-memory UX** — on app restart, the encryption key is lost. Either: prompt for password on startup, integrate with OS keyring, or derive key from a stored secret
- [ ] **Auto-sync polling** — currently polls and attempts full sync every 15s. Add a lightweight check endpoint to the E2EE server (`/api/sync/check`) to avoid unnecessary work

### Settings UI

- [ ] **Email field** — E2EE connect requires email+name (for dev login / future OIDC). Add email field to SettingsScreen
- [ ] **Connection status** — show E2EE-specific state (collection ID, object count, last sync time)
- [ ] **Password change** — requires re-encrypting all blobs with a new key
- [ ] **Force full re-sync** — button to clear `e2eeObjectMap` and re-push everything
- [x] **Disconnect** — wire up the existing "Reset connection" button to `disconnectE2ee()`

### Migration Path

- [ ] Document upgrade path for users on V2 sync: export notes, connect to E2EE server, re-sync
- [ ] Consider a one-time migration tool that reads V2 server data and pushes encrypted blobs to E2EE server

---

## Server Repo (stonefruit-server)

### Auth

- [ ] **Self-hosted password auth** — add `/setup` (first-time password with Argon2) and `/login` (password verification, returns Bearer token) endpoints to match the UX users expect
- [ ] **OIDC auth** — implement Authorization Code + PKCE flow for hosted service (Zitadel as reference provider)
- [ ] **Rate limiting** — add rate limiting on auth endpoints (5 attempts/IP/60s, matching old server)
- [ ] **Session management** — add endpoint to list/revoke sessions

### Health & Observability

- [x] **`GET /health`** — return `{ status: "ok", setup_complete: bool }` matching client expectations
- [ ] **`GET /api/dashboard/status`** — basic metrics (object count, blob size, uptime) for CLI status command
- [ ] **Structured logging** — add request logging middleware

### Sync Protocol Enhancements

- [ ] **`POST /api/sync/check`** — lightweight version check endpoint so clients can poll without doing full sync. Return `{ status: "up_to_date" | "changes_available", maxVersion: number }`
- [ ] **Pagination** — `GET /api/collections/:id/objects` should support pagination for large vaults
- [ ] **Batch blob upload** — allow uploading multiple blobs in one request to reduce round-trips

### Storage

- [ ] **S3BlobStore** — implement the `BlobStore` interface for S3-compatible storage (Cloudflare R2 for hosted, LocalStack for dev)
- [ ] **Blob cleanup** — garbage collect orphaned blobs (uploaded but never referenced by an object)
- [ ] **Size limits** — enforce per-user storage quotas for hosted service

### Deployment

- [ ] **Dockerfile** — create production Dockerfile for the Node/TS server
- [ ] **docker-compose.yml** — self-hosted compose file with PostgreSQL + server
- [ ] **docker-compose.production.yml** — for pulling pre-built image from registry
- [ ] **Environment config** — document all env vars: `DATABASE_URL`, `PORT`, `BLOB_DIR`, `AUTH_MODE` (password|oidc), `OIDC_ISSUER`, `S3_BUCKET`, etc.
- [ ] **CI/CD** — pipeline for testing, building Docker image, publishing to registry

### CLI (migrated from client repo)

- [ ] **Move `apps/cli/`** from the client monorepo to the server repo
- [ ] **Update `server_api.rs`** — new API shape (auth, health, collections endpoints)
- [ ] **Update `docker.rs`** — new Docker image reference, remove Ollama sidecar
- [ ] **Update `status.rs`** — query new health/dashboard endpoints
- [ ] **Test** — `cli-setup` flow against new server

### Hosted Service Features

- [ ] **Multi-tenancy** — user isolation is already per-query scoped; verify no cross-user leaks
- [ ] **Billing integration** — Polar or Stripe for paid subscriptions
- [ ] **Storage quotas** — per-user limits on blob storage
- [ ] **Admin panel** — user management, usage metrics
- [ ] **Backups** — automated PostgreSQL + S3 backup strategy
- [ ] **TLS** — document reverse proxy setup (Caddy/nginx) for self-hosted HTTPS

### Testing

- [ ] **Expand demo.sh** — add E2EE round-trip tests (encrypt client-side, upload, download, decrypt, verify)
- [ ] **Multi-client test** — two clients syncing through the server with conflict scenarios
- [ ] **Load testing** — verify performance with large vaults (1000+ notes)
- [ ] **Auth tests** — rate limiting, session expiry, OIDC flow

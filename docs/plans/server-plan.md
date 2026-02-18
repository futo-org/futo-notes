Let's build a server for the notes app.

Eventually, this will be home base for advanced LLM/ML features. But let's start with simple sync.

Let's think about the primary language/technologies here.

For ML/LLM features, we'll use a sidecars approach — llama.cpp and friends handle inference as standalone servers, orchestrated by our TS code. No Python or Rust needed (see ML Architecture section below). For sync/orchestration, Immich uses Typescript. Let's use Typescript with Hono. Hono has a nice CLI and can run anywhere, including Deno/Bun if that ever becomes more viable.

This is particularly helpful because my clients are written primarily in TS. We can extract and re-use types between client & server.

I want this hosted in a Docker container using Docker Compose. This way it will run just about anywhere and provide simple-enough setup. It's also the standard for self-hosted projects. I can add more later.

We'll use Volumes in the compose file. Avoid `~` in compose (shell expansion doesn't work there) — use an explicit absolute path via `${NOTES_PATH}` from `.env`, defaulting to something like `/home/user/Documents/futo-notes`.

After first setting it up, you'll need to go into your FUTO Notes app and configure the server. So we need a URL to hand off to the app. In the future, I'm going to want to integrate Cloudflare Tunnels so that you automatically get a URL you can access anywhere. For now, I'll just use a tailscale link or something.

So you give the client app the server url. Then it immediately hits /sync. Which does the following:
- client sends `{uuid, filename, modified_at, content_hash, hash_at_last_sync, content?}` for each note (content included only when `content_hash` differs from `hash_at_last_sync`), plus full list of all note UUIDs
- server matches notes by UUID, using hashes (not timestamps) for all sync decisions:
	- same UUID, client hash == `hash_at_last_sync` and server hash == `hash_at_last_sync`: no action
	- same UUID, client hash != `hash_at_last_sync`, server hash == `hash_at_last_sync`: only client changed → server stores client's content and filename
	- same UUID, client hash == `hash_at_last_sync`, server hash != `hash_at_last_sync`: only server changed → server sends client its content and filename
	- same UUID, both hashes != `hash_at_last_sync`: both sides changed → conflict (see conflict handling below)
	- UUID only on client (new note): server stores it
	- UUID only on server (client doesn't have it): server sends it to client
- `modified_at` is informational only (for UI sorting), not used in sync decisions. This avoids all clock drift issues.
- Renames are just a filename change on an existing UUID. No rename log needed. When a note is renamed on device A, it syncs as the same UUID with a new filename. Other devices pick up the new filename on next sync.
- One round trip: client sends all metadata + all changed note contents upfront, server responds with everything the client needs.

We should also keep track of "last synced" time in the client, just so we make sure to run sync every once in a while. The client should call /sync on a debounced timeout. Also trigger sync on app backgrounding/foregrounding (Capacitor `appStateChange` listener) and network reconnection — this reduces the "edited then closed app" problem where notes go missing until next open.

When both sides have changes, the server's version keeps the original filename (server is the shared authority, so this gives consistent results regardless of which device syncs). The client's version becomes the conflict copy, e.g. "my thoughts on trains (conflict 2026-02-09).md". Later we'll surface this in the UI and help you merge/update.

**Identity**: Every note gets a UUID (generated on creation). Both client and server maintain a SQLite metadata store (WAL mode for concurrent read/write) mapping `{uuid, filename, content_hash, hash_at_last_sync, created_at, modified_at}`. The .md files on disk are still named by title (e.g. `my thoughts on trains.md`) — no frontmatter, full Obsidian compatibility. UUIDs are the primary key for sync matching; filenames can change freely without breaking sync.

**Recovery**: If the metadata DB is lost or a vault is copied without it, rebuild from .md files with new UUIDs. On next sync, server falls back to filename + content hash matching to re-link notes before treating anything as new. This prevents duplicates from a DB loss.

Have a /health endpoint. Try to hit it every few minutes while app is open just in case. If server goes down, show a banner to alert the user.

Deletes are handled by a delete list. When I delete a file on the client, it is hidden from view, deleted from the filesystem, and added to a list of deleted UUIDs on the client. Next time I sync, the client sends its delete list. The server deletes those notes and keeps a tombstone record of the UUID so that other clients don't re-upload it as a new note. Server also sends its delete list to the client so deletions propagate both ways. Tombstones are kept forever in v1 (they're tiny — just a UUID + timestamp). Phase 2 can add retention rules once server cursors can confirm all clients have synced past a delete.

**Auth**
Keep it simple. Requires HTTPS or encrypted transport (e.g. Tailscale) for all password/token exchange. You spin up the server, get the url. You put that into the app. Then when the server is hit and doesn't have a password set, the client is told to set a password. So the client sets a password and sends it to the server. The server hashes it with argon2id and stores only the hash. Setup is one-time only — once a password is set, the setup endpoint is permanently locked. The server gives the client a session token (cryptographically random, stored as a hash in the DB). New devices enter the password, it's hashed and compared, and if it passes they get a new session token. Tokens are presented via `Authorization: Bearer <token>`. Tokens don't expire but are revocable — the server stores hashed tokens in a sessions table, and a `/revoke` endpoint can deauthorize specific devices or all devices.

## Phase 2 Features
* CRDT
* Server revision counter / cursor-based sync (replace timestamp ordering with monotonic server cursor)
* Cursor-based sync payloads (client sends cursor, server returns only what's changed since)
* Per-note base_rev for more precise conflict detection
* Background tasks
* store and sync other files (images!)

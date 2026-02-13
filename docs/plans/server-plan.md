Let's build a server for the notes app.

Eventually, this will be home base for advanced LLM/ML features. But let's start with simple sync.

Let's think about the primary language/technologies here.

For ML/LLM features, it seems like Python will work well, but I don't want to use Python for sync/orchestration. Immich uses Typescript. Let's use Typescript with Hono. Hono has a nice CLI and can run anywhere, including Deno/Bun if that ever becomes more viable. 

This is particularly helpful because my clients are written primarily in TS. We can extract and re-use types between client & server.

I want this hosted in a Docker container using Docker Compose. This way it will run just about anywhere and provide simple-enough setup. It's also the standard for self-hosted projects. I can add more later.

We'll use Volumes in the compose file. Avoid `~` in compose (shell expansion doesn't work there) — use an explicit absolute path via `${NOTES_PATH}` from `.env`, defaulting to something like `/home/user/Documents/futo-notes`.

After first setting it up, you'll need to go into your FUTO Notes app and configure the server. So we need a URL to hand off to the app. In the future, I'm going to want to integrate Cloudflare Tunnels so that you automatically get a URL you can access anywhere. For now, I'll just use a tailscale link or something.

So you give the client app the server url. Then it immediately hits /sync. Which does the following:
- client sends `{uuid, filename, modified_at, content_hash, content?}` for each note (content included only for notes changed since last sync), plus full list of all note UUIDs
- server matches notes by UUID:
	- same UUID, same content_hash: no action (even if mtime differs due to clock drift)
	- same UUID, different hash, client is newer: server stores client's content and filename
	- same UUID, different hash, server is newer: server sends client its content and filename
	- UUID only on client (new note): server stores it
	- UUID only on server (client doesn't have it): server sends it to client
	- both sides changed (different hashes, both modified since last sync): conflict — see conflict handling below
- Renames are just a filename change on an existing UUID. No rename log needed. When a note is renamed on device A, it syncs as the same UUID with a new filename. Other devices pick up the new filename on next sync.
- One round trip: client sends all metadata + all changed note contents upfront, server responds with everything the client needs.

We should also keep track of "last synced" time in the client, just so we make sure to run sync every once in a while. The client should call /sync on a debounced timeout. Also trigger sync on app backgrounding/foregrounding (Capacitor `appStateChange` listener) and network reconnection — this reduces the "edited then closed app" problem where notes go missing until next open.

When both sides have changes, the new file gets the o.g. name (i.e. "my thoughts on trains.md) and the old file turns to "my thoughts on trains (conflict 2026-02-09).md". Later we'll surface this in the UI and help you merge/update.

**Identity**: Every note gets a UUID (generated on creation). Both client and server maintain a SQLite metadata store (WAL mode for concurrent read/write) mapping `{uuid, filename, created_at, modified_at, last_synced}`. The .md files on disk are still named by title (e.g. `my thoughts on trains.md`) — no frontmatter, full Obsidian compatibility. UUIDs are the primary key for sync matching; filenames can change freely without breaking sync.

Have a /health endpoint. Try to hit it every few minutes while app is open just in case. If server goes down, show a banner to alert the user.

Deletes are handled by a delete list. When I delete a file on the client, it is hidden from view, deleted from the filesystem, and added to a list of deleted UUIDs on the client. Next time I sync, the client sends its delete list. The server deletes those notes and keeps a tombstone record of the UUID so that other clients don't re-upload it as a new note. Server also sends its delete list to the client so deletions propagate both ways.

**Auth**
Keep it simple. You spin up the server, get the url. You put that into the app. Then when the server is hit and doesn't have a password set, the client is told to set a password. So the client sets a password and sends it to the server. The server hashes it with argon2id and stores only the hash. Setup is one-time only — once a password is set, the setup endpoint is permanently locked. The server gives the client a session token (cryptographically random, stored as a hash in the DB). New devices enter the password, it's hashed and compared, and if it passes they get a new session token. Tokens don't expire but are revocable — the server stores hashed tokens in a sessions table, and a `/revoke` endpoint can deauthorize specific devices or all devices.

## Phase 2 Features
* CRDT
* Server revision counter / cursor-based sync (replace timestamp ordering with monotonic server cursor)
* Cursor-based sync payloads (client sends cursor, server returns only what's changed since)
* Per-note base_rev for more precise conflict detection
* Background tasks
* store and sync other files (images!)

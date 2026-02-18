# FUTO Notes Sync Server

Self-hosted sync server for FUTO Notes. Hash-based sync protocol over a single `/sync` endpoint, with argon2id auth and SQLite storage.

## Quick Start

From the **monorepo root**:

```bash
npm install
npm run server:dev       # http://localhost:3000
```

Or from `apps/server/`:

```bash
npm run dev              # Dev server with hot reload
npm run build            # Build to dist/
npm run start            # Run production build
npm test                 # Run tests
```

## Setup

On first run, set a password and log in to get a session token:

```bash
# 1. Set password (one-time)
curl -X POST http://localhost:3000/setup \
  -H 'Content-Type: application/json' \
  -d '{"password": "your-password-here"}'

# 2. Log in
curl -X POST http://localhost:3000/login \
  -H 'Content-Type: application/json' \
  -d '{"password": "your-password-here"}'
# → {"token": "abc123..."}

# 3. Sync (use the token from step 2)
curl -X POST http://localhost:3000/sync \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer abc123...' \
  -d '{"notes": [], "all_uuids": [], "deleted_uuids": []}'
```

## Configuration

Copy `.env.example` to `.env` and edit as needed:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `DATABASE_PATH` | `./data/futo-notes.db` | SQLite database file |
| `NOTES_PATH` | `./data/notes` | Directory for `.md` files |

## Docker

```bash
cd apps/server
cp .env.example .env
docker compose up
```

The Dockerfile uses the monorepo root as build context, so `docker compose build` must be run from `apps/server/` (the compose file sets `context: ../..` automatically).

Data is persisted in a Docker volume mounted at `/app/apps/server/data`.

## API

| Route | Auth | Description |
|-------|------|-------------|
| `GET /health` | No | Returns `{"status": "ok", "setup_complete": bool}` |
| `POST /setup` | No | One-time password setup. Body: `{"password": "..."}` |
| `POST /login` | No | Returns session token. Body: `{"password": "..."}` |
| `POST /sync` | Bearer | Full sync round-trip (see below) |
| `POST /revoke` | Bearer | Revoke sessions. Body: `{"mode": "current" | "all" | "specific"}` |

### Sync Protocol

The client sends all its note metadata in one request. The server compares content hashes (not timestamps) and responds with everything the client needs:

- **`update`** — Notes the client should create or overwrite
- **`delete`** — UUIDs the client should delete locally
- **`hash_updates`** — Hash confirmations so the client can update its `hash_at_last_sync`
- **`conflicts`** — Conflict copies created when both sides changed the same note

See `packages/shared/src/sync.ts` for the full request/response types.

## Architecture

```
src/
├── index.ts              # Entry point
├── app.ts                # Hono app factory
├── config.ts             # Env var loading
├── auth/
│   ├── password.ts       # argon2id hash/verify
│   └── token.ts          # Session token generation
├── db/
│   ├── index.ts          # SQLite init/singleton
│   ├── schema.ts         # Table definitions
│   ├── auth.ts           # Password hash storage
│   ├── sessions.ts       # Session CRUD
│   ├── notes.ts          # Note metadata CRUD
│   └── tombstones.ts     # Deletion records
├── middleware/
│   └── auth.ts           # Bearer token validation
├── routes/
│   ├── health.ts         # GET /health
│   ├── setup.ts          # POST /setup
│   ├── login.ts          # POST /login
│   ├── sync.ts           # POST /sync
│   └── revoke.ts         # POST /revoke
└── sync/
    ├── engine.ts         # Core sync logic
    ├── hash.ts           # SHA-256 content hashing
    ├── files.ts          # .md file I/O + filename sanitization
    └── recovery.ts       # Rebuild DB from disk on startup
```

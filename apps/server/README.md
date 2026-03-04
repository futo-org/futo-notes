# Stonefruit Sync Server

Self-hosted sync server for Stonefruit. Hash-based sync protocol over a single `/sync` endpoint, with argon2id auth and SQLite storage.

## Quick Start

From the **monorepo root**:

```bash
npm install
npm run server:dev       # http://localhost:3005
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
curl -X POST http://localhost:3005/setup \
  -H 'Content-Type: application/json' \
  -d '{"password": "your-password-here"}'

# 2. Log in
curl -X POST http://localhost:3005/login \
  -H 'Content-Type: application/json' \
  -d '{"password": "your-password-here"}'
# → {"token": "abc123..."}

# 3. Sync (use the token from step 2)
curl -X POST http://localhost:3005/sync \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer abc123...' \
  -d '{"notes": [], "all_uuids": [], "deleted_uuids": []}'
```

## Configuration

Copy `.env.example` to `.env` and edit as needed:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3005` | HTTP server port |
| `DATABASE_PATH` | `./data/stonefruit.db` | SQLite database file |
| `NOTES_PATH` | `./data/notes` | Directory for `.md` files |

## Docker

### Run with Docker (recommended)

Pull the pre-built image from the GitLab Container Registry — no clone needed:

```bash
# Download the production compose file
curl -O https://gitlab.futo.org/stonefruit/stonefruit/-/raw/main/apps/server/docker-compose.production.yml

# Start the server
docker compose -f docker-compose.production.yml up -d
```

The server will be available at `http://localhost:3005`. Data is persisted in a Docker volume.

### Run hardware benchmark from Docker image (no repo required)

If the server container is already running:

```bash
docker exec -it <container_name_or_id> node dist/benchmark.js
```

If you only have the image and want a one-shot benchmark:

```bash
docker run --rm -it \
  -v stonefruit-data:/app/apps/server/data \
  --entrypoint node \
  gitlab.futo.org:5050/stonefruit/stonefruit/server:latest \
  dist/benchmark.js
```

With compose (`docker-compose.production.yml`):

```bash
docker compose -f docker-compose.production.yml exec server node dist/benchmark.js
```

### Build from source

If you've cloned the monorepo and want to build locally:

```bash
cd apps/server
cp .env.example .env
docker compose up
```

The Dockerfile uses the monorepo root as build context, so `docker compose build` must be run from `apps/server/` (the compose file sets `context: ../..` automatically).

Data is persisted in a Docker volume mounted at `/app/apps/server/data`.

## HTTPS / Remote Access

The server runs plain HTTP. For HTTPS, use one of these options:

### Tailscale (recommended for personal use)

If you have [Tailscale](https://tailscale.com/) installed on your server and phone/laptop, one command gives you trusted HTTPS accessible from all your devices:

```bash
tailscale serve 3005
```

Your server is now available at `https://<hostname>.<tailnet>.ts.net` with automatic TLS certificates. Only devices on your Tailscale network can reach it.

To expose it publicly (anyone on the internet can access it):

```bash
tailscale funnel 3005
```

### Cloudflare Tunnel (no open ports needed)

[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) gives you a public HTTPS URL without opening any ports on your router. Requires a free Cloudflare account and a domain on Cloudflare DNS.

1. Create a tunnel in the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/) and copy the tunnel token.

2. Add `cloudflared` to your compose file:

```yaml
services:
  server:
    image: gitlab.futo.org:5050/stonefruit/stonefruit/server:latest
    volumes:
      - data:/app/apps/server/data
    environment:
      - PORT=3005
      - DATABASE_PATH=./data/stonefruit.db
      - NOTES_PATH=./data/notes
    restart: unless-stopped

  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run --token ${TUNNEL_TOKEN}
    network_mode: service:server

volumes:
  data:
```

3. Set `TUNNEL_TOKEN` in a `.env` file and configure the tunnel's public hostname in the Cloudflare dashboard to point to `http://localhost:3005`.

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

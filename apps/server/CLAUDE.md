# CLAUDE.md - FUTO Notes Server

Self-hosted sync server for FUTO Notes. See [`docs/plans/server-plan.md`](../../docs/plans/server-plan.md) for the full architecture plan.

## Stack

- **Hono** — HTTP framework (lightweight, runs anywhere)
- **better-sqlite3** — Embedded database for note metadata and sync state
- **Docker** — Container deployment via docker-compose
- **@futo-notes/shared** — Shared types with the client

## Sync Protocol Overview

Single-endpoint hash-based sync (`POST /sync`):
- Client sends `{uuid, filename, modified_at, content_hash, hash_at_last_sync, content?}` for each note
- Server compares hashes (not timestamps) to determine sync direction
- One round trip: client sends all changes, server responds with everything the client needs
- See `docs/plans/server-plan.md` for detailed sync logic and conflict handling

## Real-Time Notifications (SSE)

`GET /events?token=<token>&clientId=<uuid>` — Server-Sent Events endpoint for push notifications.

- After a sync with changes, the server broadcasts `sync_available` to all other connected clients
- Clients exclude themselves via `X-Client-Id` header on `POST /sync`
- SSE is purely a "go sync now" signal — no note data flows over it
- Auth via query param (EventSource doesn't support custom headers)
- 30s keepalive heartbeat; revoked sessions get their SSE connections closed

## Tools

- **Hono CLI** is installed on this system — run `hono` to see available commands (scaffolding, etc.).

## Running

```bash
# Development (from monorepo root):
npm run server:dev

# Docker:
cd apps/server
cp .env.example .env           # Edit configuration
docker-compose up
```

## Configuration

See `.env.example` for available settings:
- `PORT` — Server port (default: 3005)
- `DATABASE_PATH` — SQLite database location

## Key Files

- `src/events.ts` — SSE client registry, broadcast, heartbeat
- `src/routes/events.ts` — `GET /events` SSE endpoint
- `src/routes/sync.ts` — `POST /sync` with SSE broadcast hook
- `src/sync/engine.ts` — Core sync logic (hash comparison, conflict resolution)

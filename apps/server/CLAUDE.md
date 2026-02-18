# CLAUDE.md - FUTO Notes Server

Self-hosted sync server for FUTO Notes. See [`docs/plans/server-plan.md`](../../docs/plans/server-plan.md) for the full architecture plan.

## Stack

- **Hono** — HTTP framework (lightweight, runs anywhere)
- **better-sqlite3** — Embedded database for note metadata and sync state
- **Docker** — Container deployment via docker-compose
- **@futo-notes/shared** — Shared types with the client

## Sync Protocol Overview

Single-endpoint hash-based sync (`/sync`):
- Client sends `{uuid, filename, modified_at, content_hash, hash_at_last_sync, content?}` for each note
- Server compares hashes (not timestamps) to determine sync direction
- One round trip: client sends all changes, server responds with everything the client needs
- See `docs/plans/server-plan.md` for detailed sync logic and conflict handling

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
- `PORT` — Server port (default: 3000)
- `DATABASE_PATH` — SQLite database location

## Status

This package is scaffolded but not yet implemented. The `src/index.ts` is a placeholder.

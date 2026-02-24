# CLAUDE.md - FUTO Notes Server

Self-hosted Hono sync server. See @docs/plans/server-plan.md for full architecture.

**Stack**: Hono + better-sqlite3 + Docker. Uses `@futo-notes/shared` for shared types.

## Sync Protocol

Single-endpoint hash-based sync (`POST /sync`):
- Client sends `{uuid, filename, modified_at, content_hash, hash_at_last_sync, content?}` per note
- Server compares hashes (not timestamps) to determine sync direction
- One round trip: client sends all changes, server responds with everything needed

## SSE Notifications

`GET /events?token=<token>&clientId=<uuid>` — push "go sync now" signals (no note data over SSE). Auth via query param (EventSource doesn't support headers). 30s heartbeat.

## Configuration

See `.env.example`: `PORT` (default 3005), `DATABASE_PATH`.

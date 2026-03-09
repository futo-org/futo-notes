# AGENTS.md - Stonefruit Server

Self-hosted Hono sync server. See @docs/plans/server-plan.md for full architecture.

**Stack**: Hono + better-sqlite3 + Docker. Uses `@futo-notes/shared` for shared types.
Client shell/runtime is Tauri v2 in this monorepo.

## Sync Protocol

Single-endpoint hash-based sync (`POST /sync`):
- Client sends `{uuid, filename, modified_at, content_hash, hash_at_last_sync, content?}` per note
- Server compares hashes (not timestamps) to determine sync direction
- One round trip: client sends all changes, server responds with everything needed

## SSE Notifications

`GET /events?token=<token>&clientId=<uuid>` — push "go sync now" signals (no note data over SSE). Auth via query param (EventSource doesn't support headers). 30s heartbeat.

## Configuration

See `.env.example`: `PORT` (default 3005), `DATABASE_PATH`.

## Verification (Required)

| What changed | Run |
|---|---|
| Any server code | `npm test` in `apps/server/` (or `npm run server:test` from root) |
| Dockerfile / docker-compose | Above, then `docker compose up --build` → `curl -sf http://localhost:3005/health` → `docker compose down` |
| Auth or sync logic | Above, then run setup, login, and sync smoke requests (see `apps/server/README.md`) |

If anything fails: check `docker compose logs`, fix, rerun. Do not report completion until passing.

## Error Handling

When the user pastes a server error or failing test: grep for the error in `apps/server/src/`, read the source, check `git log --oneline -5 -- <file>`, fix, and rerun `npm test`. Don't ask — act.

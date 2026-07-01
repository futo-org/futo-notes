#!/usr/bin/env bash
# Boot futo-notes-server in password mode for local development and testing.
#
# Defaults:
#   AUTH_MODE=password, password "testing123", port 3100.
#   Postgres via the server repo's docker-compose (port 5433).
#
# Overrides:
#   FUTO_NOTES_E2EE_SERVER_REPO  path to futo-notes-server checkout
#   FUTO_NOTES_TEST_PASSWORD     server password
#   FUTO_NOTES_SERVER_PORT       HTTP port
#   FUTO_NOTES_DATABASE_URL      Postgres DSN
#
# Usage (from client repo root):
#   ./scripts/start-test-server.sh            # foreground
#
# The client connects with:
#   await window.__testSync.connect('http://127.0.0.1:3100', 'testing123')
set -euo pipefail

SERVER_REPO="${FUTO_NOTES_E2EE_SERVER_REPO:-$HOME/Developer/futo-notes-server}"
PASSWORD="${FUTO_NOTES_TEST_PASSWORD:-testing123}"
PORT="${FUTO_NOTES_SERVER_PORT:-3100}"
DATABASE_URL="${FUTO_NOTES_DATABASE_URL:-postgres://futo_notes:futo_notes@localhost:5433/futo_notes}"

if [ ! -f "$SERVER_REPO/package.json" ]; then
  echo "error: server repo not found at $SERVER_REPO" >&2
  echo "       set FUTO_NOTES_E2EE_SERVER_REPO to your checkout." >&2
  exit 1
fi

cd "$SERVER_REPO"

if [ ! -d node_modules ]; then
  echo "[start-test-server] Installing pnpm deps..."
  pnpm install --silent
fi

echo "[start-test-server] Bringing up Postgres (docker compose)..."
docker compose up -d postgres >/dev/null

echo "[start-test-server] Waiting for Postgres..."
for _ in $(seq 1 30); do
  if docker compose exec -T postgres pg_isready -U futo_notes -d futo_notes >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "[start-test-server] Hashing password..."
# The server is bun-only now; `pnpm exec tsx` drifted (tsx is not a server dep)
# and fails under `set -e`, exiting silently right after this line. Use bun,
# matching the cross-platform harness (tests/lib/sync-test-server.mjs).
HASH=$(bun src/index.ts hash "$PASSWORD")
if [ -z "$HASH" ]; then
  echo "error: failed to compute password hash" >&2
  exit 1
fi

cat <<EOF

  URL:      http://127.0.0.1:$PORT
  Password: $PASSWORD
  Mode:     AUTH_MODE=password

  In the Tauri dev console:
    await window.__testSync.connect('http://127.0.0.1:$PORT', '$PASSWORD')

  Ctrl-C to stop.

EOF

exec env \
  AUTH_MODE=password \
  FUTO_NOTES_PASSWORD_HASH="$HASH" \
  PORT="$PORT" \
  DATABASE_URL="$DATABASE_URL" \
  pnpm start

#!/usr/bin/env bash
# Boot futo-notes-server in password mode for local development and testing.
#
# It runs the release pinned in scripts/sync-server-pin.json, downloaded on
# first use — no server checkout, no database server, nothing to install. State
# (SQLite database + blobs) lives in a directory you can delete.
#
# Defaults:
#   AUTH_MODE=password, password "testing123", port 3100.
#
# Overrides:
#   FUTO_NOTES_TEST_PASSWORD     server password
#   FUTO_NOTES_SERVER_PORT       HTTP port
#   FUTO_NOTES_SERVER_DATA       state directory (default: .tauri-data/test-sync-server)
#   FUTO_NOTES_E2EE_SERVER_REPO  a futo-notes-server checkout to build and run instead
#   FUTO_NOTES_E2EE_SERVER_BIN   a server binary to run instead
#
# Usage (from client repo root):
#   ./scripts/start-test-server.sh            # foreground
#
# The client connects with:
#   await window.__testSync.connect('http://127.0.0.1:3100', 'testing123')
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PASSWORD="${FUTO_NOTES_TEST_PASSWORD:-testing123}"
PORT="${FUTO_NOTES_SERVER_PORT:-3100}"
DATA_DIR="${FUTO_NOTES_SERVER_DATA:-$REPO_ROOT/.tauri-data/test-sync-server}"

# One owner for "where is the sync server" — see scripts/lib/sync-server.mjs.
SERVER_BIN=$(node "$REPO_ROOT/scripts/lib/sync-server.mjs" path)

mkdir -p "$DATA_DIR/blobs"

cat <<INFO

  URL:      http://127.0.0.1:$PORT
  Password: $PASSWORD
  Mode:     AUTH_MODE=password
  Server:   $SERVER_BIN
  Data:     $DATA_DIR

  In the Tauri dev console:
    await window.__testSync.connect('http://127.0.0.1:$PORT', '$PASSWORD')

  Ctrl-C to stop.

INFO

# Started from the data directory: the server reads a `.env` from its working
# directory, and the repo root is not a place to pick up config from.
cd "$DATA_DIR"
exec env \
  AUTH_MODE=password \
  FUTO_NOTES_PASSWORD="$PASSWORD" \
  PORT="$PORT" \
  BLOB_DIR="$DATA_DIR/blobs" \
  DATABASE_URL="sqlite:$DATA_DIR/notes.db" \
  "$SERVER_BIN"

#!/usr/bin/env bash
#
# Install (or refresh) the systemd user timer that runs the weekly papercut
# sweep. Idempotent — re-run after pulling a new version of the units, after
# upgrading node, or from a different checkout to repoint the unit at it.
#
# Prerequisite: ~/.config/futo-notes-papercut-sweep/env exists (copy
# env.example, fill in GITLAB_TOKEN, chmod 600). The claude CLI must be logged
# in for the user running the timer (`claude` in a terminal once).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
ENV_FILE="$HOME/.config/futo-notes-papercut-sweep/env"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE — copy env.example there, fill in GITLAB_TOKEN, chmod 600." >&2
  exit 1
fi

# Absolute paths, because systemd never sees nvm or the shell profile.
NODE_BIN="$(command -v node)"
[ -n "$NODE_BIN" ] || { echo "node not found on PATH" >&2; exit 1; }
command -v claude >/dev/null || { echo "claude CLI not found on PATH — the agent cannot start" >&2; exit 1; }
command -v just >/dev/null || { echo "just not found on PATH — the agent cannot run checks" >&2; exit 1; }

echo "node:  $NODE_BIN"
echo "repo:  $REPO_DIR"
echo "units: $UNIT_DIR"
echo "path:  $PATH"

mkdir -p "$UNIT_DIR"
sed -e "s#__NODE_BIN__#${NODE_BIN}#g" -e "s#__REPO_DIR__#${REPO_DIR}#g" -e "s#__PATH__#${PATH}#g" \
  "$SCRIPT_DIR/futo-notes-papercut-sweep.service" > "$UNIT_DIR/futo-notes-papercut-sweep.service"
sed -e "s#__REPO_DIR__#${REPO_DIR}#g" \
  "$SCRIPT_DIR/futo-notes-papercut-sweep.timer" > "$UNIT_DIR/futo-notes-papercut-sweep.timer"

systemctl --user daemon-reload
systemctl --user enable --now futo-notes-papercut-sweep.timer

echo
echo "Installed. Next run:"
systemctl --user list-timers futo-notes-papercut-sweep.timer --no-pager || true
echo
echo "Run one now:   systemctl --user start futo-notes-papercut-sweep.service"
echo "Dry run:       node $REPO_DIR/scripts/papercut-sweep/sweep.mjs --dry-run"
echo "Logs:          journalctl --user -u futo-notes-papercut-sweep.service -n 50"
echo "Last result:   cat ~/.local/state/futo-notes-papercut-sweep/last-run.json   (also in: just orient)"

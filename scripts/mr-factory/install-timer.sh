#!/usr/bin/env bash
#
# Install (or refresh) the systemd user timer that runs the MR factory hourly.
# Idempotent — re-run after pulling new units or upgrading node.
#
# Prerequisites: ~/.config/futo-notes-mr-factory/env exists (copy env.example,
# fill it in, chmod 600), and the claude and codex CLIs are logged in for this
# user.
#
# Install from the primary checkout, not a worktree: the units bake in this
# checkout's path, and `just wt gc` deletes worktrees. The papercut sweep's
# unit pointed at a deleted worktree and failed with MODULE_NOT_FOUND on
# 2026-10-26. --allow-worktree overrides this for a deliberate trial.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
ENV_FILE="$HOME/.config/futo-notes-mr-factory/env"

if [ "${1:-}" != "--allow-worktree" ] &&
  [ "$(git -C "$REPO_DIR" rev-parse --absolute-git-dir)" != "$(cd "$(git -C "$REPO_DIR" rev-parse --git-common-dir)" && pwd)" ]; then
  echo "$REPO_DIR is a worktree; install from the primary checkout (or pass --allow-worktree)." >&2
  exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE — copy env.example there, fill it in, chmod 600." >&2
  exit 1
fi

. "$REPO_DIR/scripts/lib/stable-node-path.sh"
for tool in claude codex just pnpm adb; do
  command -v "$tool" >/dev/null || { echo "$tool not found on PATH — /mr-qa needs it" >&2; exit 1; }
done

echo "node:  $NODE_BIN"
echo "repo:  $REPO_DIR"
echo "units: $UNIT_DIR"
echo "path:  $PATH"

mkdir -p "$UNIT_DIR"
for unit in futo-notes-mr-factory.service futo-notes-mr-factory-failure.service futo-notes-mr-factory.timer; do
  sed -e "s#__NODE_BIN__#${NODE_BIN}#g" -e "s#__REPO_DIR__#${REPO_DIR}#g" \
    -e "s#__PATH__#${PATH}#g" -e "s#__ANDROID_HOME__#${ANDROID_HOME:-}#g" \
    "$SCRIPT_DIR/$unit" > "$UNIT_DIR/$unit"
done

systemctl --user daemon-reload
systemctl --user enable --now futo-notes-mr-factory.timer

echo
echo "Installed. Next run:"
systemctl --user list-timers futo-notes-mr-factory.timer --no-pager || true
echo
echo "Dry run:       node $REPO_DIR/scripts/mr-factory/sweep.mjs --dry-run   (needs GITLAB_TOKEN)"
echo "Run one now:   systemctl --user start --no-block futo-notes-mr-factory.service"
echo "Logs:          journalctl --user -u futo-notes-mr-factory.service -n 50"
echo "Stop it:       systemctl --user disable --now futo-notes-mr-factory.timer"

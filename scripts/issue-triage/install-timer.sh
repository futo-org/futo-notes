#!/usr/bin/env bash
#
# Install (or refresh) the systemd user timer that runs tier 1 of the GitHub
# issue triage system every 15 minutes. Idempotent — safe to re-run after
# pulling a new version of the units or upgrading node.
#
# Prerequisite: ~/.config/futo-notes-issue-triage/env exists (copy env.example,
# fill in real credentials, chmod 600).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
ENV_FILE="$HOME/.config/futo-notes-issue-triage/env"

# Verify the credential file exists before installing anything.
if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE — copy env.example there and fill it in first." >&2
  exit 1
fi

# Resolve the node binary now; the units bake in an absolute path so systemd
# (which has a minimal PATH and never sees nvm) can find it.
NODE_BIN="$(command -v node)"
[ -n "$NODE_BIN" ] || { echo "node not found on PATH" >&2; exit 1; }

echo "node:  $NODE_BIN"
echo "repo:  $REPO_DIR"
echo "units: $UNIT_DIR"

# Substitute the machine-specific paths into the committed unit templates.
mkdir -p "$UNIT_DIR"
sed -e "s#__NODE_BIN__#${NODE_BIN}#g" -e "s#__REPO_DIR__#${REPO_DIR}#g" \
  "$SCRIPT_DIR/futo-notes-issue-triage.service" \
  > "$UNIT_DIR/futo-notes-issue-triage.service"
sed -e "s#__REPO_DIR__#${REPO_DIR}#g" \
  "$SCRIPT_DIR/futo-notes-issue-triage.timer" \
  > "$UNIT_DIR/futo-notes-issue-triage.timer"

# Reload so systemd picks up the (re)written units, then enable + start the timer.
systemctl --user daemon-reload
systemctl --user enable --now futo-notes-issue-triage.timer

echo
echo "Installed. Next runs:"
systemctl --user list-timers futo-notes-issue-triage.timer --no-pager || true
echo
echo "One-off manual poll:  systemctl --user start futo-notes-issue-triage.service"
echo "Logs:                 journalctl --user -u futo-notes-issue-triage.service -n 50"

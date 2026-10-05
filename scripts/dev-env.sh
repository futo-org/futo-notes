#!/usr/bin/env bash
# Non-interactive entry point, including SSH shells that cannot find node/just.
# Only --install provisions Node/fnm. No shell profile or global default is edited.
set -euo pipefail
dev_repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$dev_repo_root"
dev_install=false
if [ "${1:-}" = --install ]; then dev_install=true; shift; fi
if [ "$#" -eq 0 ]; then
  echo 'Usage: bash scripts/dev-env.sh [--install] <command> [arguments...]' >&2
  exit 2
fi
dev_node_pin=$(tr -d '[:space:]' < .nvmrc)
export PATH="$HOME/.nvm/versions/node/v${dev_node_pin}/bin:$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.local/share/fnm:/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ "$(node --version 2>/dev/null || :)" != "v$dev_node_pin" ]; then
  if ! command -v fnm >/dev/null 2>&1 && "$dev_install"; then
    case "$(uname -s)" in
      Darwin) brew install fnm >&2 ;;
      Linux)
        mkdir -p "$HOME/.local/bin"
        FNM_INSTALL_DIR="$HOME/.local/bin" sh ci/install-fnm.sh >&2
        ;;
      *) echo 'dev-env: install fnm for this platform first' >&2; exit 1 ;;
    esac
  fi
  if ! command -v fnm >/dev/null 2>&1; then
    echo 'dev-env: pinned Node is missing; run bash scripts/dev-env.sh --install just setup' >&2
    exit 1
  fi
  eval "$(fnm env --shell bash)"
  if "$dev_install"; then fnm use --install-if-missing "$dev_node_pin" >&2;
  else fnm use "$dev_node_pin" >&2; fi
fi
if [ "$(node --version)" != "v$dev_node_pin" ]; then
  echo "dev-env: Node does not match .nvmrc ($dev_node_pin)" >&2
  exit 1
fi
exec "$@"

# Sourced by the systemd timer installers. Sets NODE_BIN to an absolute node
# path that outlives the installing shell, and rewrites PATH the same way.
#
# Under fnm, `command -v node` resolves to a per-shell
# /run/user/.../fnm_multishells/<id>/bin that is deleted when the shell exits,
# so a unit baked with it fails 203/EXEC on its next run. fnm's default alias
# directory is stable across shells. (The MR factory ran dead for 17 hours on
# 2026-10-26 because its units still named a removed ~/.nvm node.)

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "node not found on PATH" >&2; exit 1; }

case "$NODE_BIN" in
*/fnm_multishells/*)
  FNM_DEFAULT_BIN="${FNM_DIR:-$HOME/.local/share/fnm}/aliases/default/bin"
  [ -x "$FNM_DEFAULT_BIN/node" ] || { echo "fnm has no default alias at $FNM_DEFAULT_BIN — run: fnm default <version>" >&2; exit 1; }
  NODE_BIN="$FNM_DEFAULT_BIN/node"
  PATH="$(printf '%s' "$PATH" | sed -E "s#[^:]*/fnm_multishells/[^:]*#${FNM_DEFAULT_BIN}#g")"
  ;;
esac

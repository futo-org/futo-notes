#!/usr/bin/env bash
# Run a command inside a private headless KWin (Wayland) on its own D-Bus session,
# so a desktop test can ask a real window manager to close the app's window.
#
#   bash scripts/run-under-virtual-kwin.sh node tests/desktop-close-deadline.mjs
#
# Linux only; needs kwin_wayland and dbus-run-session. The command's output is
# relayed at the end, not streamed: the D-Bus-activated portal daemons outlive the
# session and would hold a pipe open for ever (ssh would never return).
set -u
[ "$#" -gt 0 ] || { echo "usage: $0 <command> [args...]" >&2; exit 2; }
log="$(mktemp "${TMPDIR:-/tmp}/virtual-kwin-XXXXXX.log")"
socket="wl-test-$$"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
dbus-run-session -- bash -c '
  socket=$1; shift
  kwin_wayland --virtual --socket "$socket" --width 1600 --height 1000 >/dev/null 2>&1 &
  kwin=$!
  for _ in $(seq 1 50); do [ -S "$XDG_RUNTIME_DIR/$socket" ] && break; sleep 0.2; done
  export WAYLAND_DISPLAY="$socket" GDK_BACKEND=wayland WINIT_UNIX_BACKEND=wayland
  "$@"; status=$?
  kill "$kwin" 2>/dev/null
  exit $status
' bash "$socket" "$@" >"$log" 2>&1 </dev/null
status=$?
grep -v -E '^dbus-daemon\[|xdg-desktop-portal|^$|SpiRegistry' "$log"
rm -f "$log"
exit $status

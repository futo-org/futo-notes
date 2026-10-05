#!/bin/sh
# Ask the KWin of the current DBUS_SESSION_BUS_ADDRESS to close every normal
# window: what a titlebar X or Alt+F4 does. A window-manager close request, not
# OS input. Used by tests/desktop-close-deadline.mjs under a private kwin_wayland.
set -eu
script="$(mktemp "${TMPDIR:-/tmp}/kwin-close-XXXXXX.js")"
name="futo-close-$$"
trap 'rm -f "$script"' EXIT
cat >"$script" <<'JS'
var n = 0;
var list = workspace.windowList();
for (var i = 0; i < list.length; i++) {
  if (list[i].normalWindow) { n++; list[i].closeWindow(); }
}
print("kwin-close: requested close on " + n + " window(s)");
JS
id=$(gdbus call --session --dest org.kde.KWin --object-path /Scripting \
  --method org.kde.kwin.Scripting.loadScript "$script" "$name" | tr -dc 0-9)
gdbus call --session --dest org.kde.KWin --object-path "/Scripting/Script$id" \
  --method org.kde.kwin.Script.run >/dev/null
gdbus call --session --dest org.kde.KWin --object-path /Scripting \
  --method org.kde.kwin.Scripting.unloadScript "$name" >/dev/null

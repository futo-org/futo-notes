# Parallel QA isolation, agent worktree tooling, and simulator/emulator helpers. Imported by the root justfile.

# ── Parallel QA isolation (multiple worktrees, one machine; model: scripts/qa.mjs) ──

# Claim (create + boot if needed) this worktree's pooled simulator/emulator.
qa-claim target="all" *flags:
  @node scripts/qa.mjs claim "$@"

# Show pool devices + per-slot sync servers, and which worktree owns each.
qa-status:
  @node scripts/qa.mjs status

# Print every port this worktree owns.
ports:
  @node scripts/lib/slot.mjs

# Release this worktree's devices + sync server; `ios`/`android` releases one device, server left up (--shutdown powers off).
qa-release *flags:
  @node scripts/qa.mjs release "$@"

# Reap pool devices/servers owned by worktrees that no longer exist.
qa-gc:
  @node scripts/qa.mjs gc

# Seed a QA worktree with a warm cargo build (copy-on-write clone of target/: APFS or btrfs).
qa-clone-target dest:
  @node scripts/worktree.mjs clone-target "$1"

# Start this worktree's isolated sync server; --standin for hosted test mode — see justfile-notes.md.
qa-server *flags:
  @node scripts/qa.mjs server-start "$@"

# Stop it (add --drop to also delete its database and blobs).
qa-server-stop *flags:
  @node scripts/qa.mjs server-stop "$@"

# ── Agent developer experience (worktrees, orientation, waiting; docs/plan/agent-dx.md) ──

# Create with `just wt <name>` (or `new <name>`), list worktrees, or reap stale ones.
wt *args:
  #!/usr/bin/env bash
  exec node scripts/worktree.mjs "$@"

# Where am I: worktree, slot, ports, devices, dirty state, relevant papercuts.
orient *args:
  #!/usr/bin/env bash
  exec node scripts/agent-orient.mjs "$@"

# Block until a GitLab pipeline finishes; exit by its status; print failed traces.
ci-wait *args:
  #!/usr/bin/env bash
  exec node scripts/ci-wait.mjs wait "$@"

# Open MRs oldest first: iid, draft/ready, head-pipeline status, branch, title.
mr-status:
  @node scripts/ci-wait.mjs mr-status

# Run a long command detached with a durable log and exit file under .futo/runs/.
detached *args:
  #!/usr/bin/env bash
  exec node scripts/detached.mjs "$@"

# The weekly papercut sweep: a scheduled headless Opus session fixes tooling
# friction from .papercuts.jsonl; see scripts/papercut-sweep/README.md.
# Install the weekly papercut-sweep systemd user timer on this machine.
papercut-sweep-install:
  bash scripts/papercut-sweep/install-timer.sh

# One sweep now (`--dry-run` sets up the worktree and prints the prompt only).
papercut-sweep *args:
  #!/usr/bin/env bash
  exec node scripts/papercut-sweep/sweep.mjs "$@"

# ── Simulator / emulator QA helpers (mechanics; judgment lives in /verify's references/) ──

# Boot an iOS simulator by name (no-op if already booted) and wait for it.
sim-boot name="iPhone 17 Pro":
  #!/usr/bin/env bash
  set -euo pipefail
  xcrun simctl boot '{{name}}' 2>/dev/null || true  # "already booted" is fine
  # SHOW=1 foregrounds Simulator.app; headless by default. Xcode 27 ships no
  # Simulator.app — its replacement, DeviceHub, takes the touchscreen of EVERY
  # booted simulator while it runs, so refuse instead of opening it.
  if [ -n "${SHOW:-}" ] && ! open -a Simulator; then
    echo "SHOW=1: no Simulator.app (Xcode 27+). Not opening DeviceHub, which breaks scripted taps on every booted simulator; watch with: just sim-screenshot" >&2
    exit 1
  fi
  for i in $(seq 1 30); do
    xcrun simctl list devices booted | grep -q Booted && break; sleep 1
  done
  just sim-udid

# Print the target simulator UDID: $SIM when set, else the single booted one.
sim-udid:
  #!/usr/bin/env bash
  set -euo pipefail
  if [ -n "${SIM:-}" ]; then echo "$SIM"; exit 0; fi
  UDIDS=$(xcrun simctl list devices booted | sed -n 's/.*(\([0-9A-Fa-f-]\{36\}\)).*Booted.*/\1/p')
  COUNT=$(printf '%s' "$UDIDS" | grep -c . || true)
  [ "$COUNT" -ge 1 ] || { echo "No booted simulator. Boot one: just sim-boot (or just qa-claim ios)" >&2; exit 1; }
  [ "$COUNT" -eq 1 ] || { echo "Multiple booted simulators — set SIM=<udid> (just qa-claim ios prints it):" >&2; echo "$UDIDS" >&2; exit 1; }
  echo "$UDIDS"

# Screenshot the target simulator ($SIM, else booted), isolated by worktree and device.
sim-screenshot name="sim":
  #!/usr/bin/env bash
  set -euo pipefail
  SLOT=$(node scripts/lib/slot.mjs slot)
  DEVICE="${SIM:-booted}"
  OUT="test-screenshots/ios/s${SLOT}/${DEVICE}/$1.png"
  mkdir -p "$(dirname "$OUT")"
  xcrun simctl io "$DEVICE" screenshot "$OUT"

# Flip the target simulator's system appearance (dark|light).
sim-appearance mode="dark":
  xcrun simctl ui "${SIM:-booted}" appearance {{mode}}

# Screenshot the connected Android device/emulator, isolated by worktree and device.
emu-screenshot name="emu":
  #!/usr/bin/env bash
  set -euo pipefail
  SLOT=$(node scripts/lib/slot.mjs slot)
  DEVICE="${ANDROID_SERIAL:-$(adb get-serialno)}"
  OUT="test-screenshots/android/s${SLOT}/${DEVICE}/$1.png"
  mkdir -p "$(dirname "$OUT")"
  adb -s "$DEVICE" exec-out screencap -p > "$OUT"

# Tag-scoped logcat for the native Android app's stable log tags.
emu-logs:
  # `adb logcat -c` first for a clean slate; crashes land under AndroidRuntime.
  adb logcat -s FutoStartup FutoSearch NotesStore FutoLicense SyncManager PlatformTrust FutoTestHook FutoToolbarDBG FutoBridgeDBG AndroidRuntime

# Forward the Android app's WebView DevTools socket for cdp-invoke.mjs.
cdp-forward:
  #!/usr/bin/env bash
  set -euo pipefail
  # Debug builds only; re-run after every app restart. Port derivation: justfile-notes.md.
  PORT="${CDP_PORT:-$(node scripts/lib/slot.mjs cdp)}"
  PID=$(adb shell pidof com.futo.notes.dev | tr -d '\r')
  [ -n "$PID" ] || { echo "com.futo.notes.dev is not running — launch the app first." >&2; exit 1; }
  SOCKET=$(adb shell 'cat /proc/net/unix' | grep -o "webview_devtools_remote_${PID}" | head -1)
  [ -n "$SOCKET" ] || { echo "No DevTools socket for pid $PID — has the editor WebView been opened yet?" >&2; exit 1; }
  adb forward "tcp:${PORT}" "localabstract:${SOCKET}"
  echo "Forwarded localhost:${PORT} → ${SOCKET}"
  echo "  export CDP_PORT=${PORT}   # then: node scripts/cdp-invoke.mjs \"document.title\""

# Drive the native Android app: read its state, tap labels, run debug hooks.
android-drive *args:
  @node scripts/android-drive.mjs "$@"

# Screenshot this worktree's desktop QA window WITHOUT activating it; see justfile-notes.md.
#   just qa-shot list | pid <pid> | port <port> [--out <path>]
qa-shot *args:
  @node scripts/qa-shot.mjs "$@"

# Resolve a desktop QA target safely — the ONLY sanctioned port/PID → process lookup.
#   just qa-target list | status | pid <pid> | port <port> | kill
qa-target *args:
  @node scripts/qa-target.mjs "$@"

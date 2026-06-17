---
name: verify
description: Run the appropriate verification chain for recent changes. Detects what changed and runs build, tests, smoke checks, and visual UI verification. Use when the user says "verify", "check this", "does it work", "test it", "make sure X works", or after completing a feature/fix. Also use when the user wants to visually confirm UI changes work in the desktop Tauri app or on Android, or when they ask to verify a specific feature regardless of recent changes.
---

# Verify

Two modes: **change verification** (what did I break?) and **feature verification** (does X work?). Detect which mode from context, run the right checks, visually verify UI when applicable. Report clearly.

## Which mode?

- **Change verification** — user says "verify", "check this", "does it work" after making changes. Detect what changed, run matching test chains.
- **Feature verification** — user says "verify wikilinks work", "make sure sync works on desktop", "test the editor". Skip git diff detection. Instead, identify which test suites and UI flows cover the named feature, run those directly, and do a hands-on UI check.

For feature verification, skip to Step 2 and pick the relevant chains yourself based on the feature. Always include Step 3 (UI verification) if the feature is user-facing.

## Instance Setup (always run first)

Multiple Tauri instances can run simultaneously from different git worktrees. Each worktree gets unique ports derived from its path so instances never collide. Run this once at the start of every `/verify` invocation and reference the variables in all subsequent commands.

```bash
WORKTREE_ROOT="$(git rev-parse --show-toplevel)"
SLOT=$(( $(printf "%d" "0x$(echo -n "$WORKTREE_ROOT" | md5sum | cut -c1-8)") % 50 ))
VITE_PORT=$(( 5200 + SLOT ))
WEB_VITE_PORT=$(( 5250 + SLOT ))
TAURI_LOG="/tmp/tauri-verify-${SLOT}.log"
PID_FILE="/tmp/tauri-verify-${SLOT}.pid"
echo "Worktree: $WORKTREE_ROOT → Vite port $VITE_PORT, web port $WEB_VITE_PORT (slot $SLOT)"
```

Since shell variables don't persist between separate Bash tool calls, **re-compute these values** (or source-paste them) at the start of any Bash block that needs them.

> **Parallel worktree setup**: When setting up multiple worktrees, run `pnpm install` in all of them concurrently — they have separate `node_modules` and don't conflict. This saves ~12s per additional worktree.

| Purpose | Range | Notes |
|---|---|---|
| Tauri Vite (per worktree) | 5200–5249 | Avoids 5173/5180–5182 |
| Web Vite (per worktree) | 5250–5299 | Separate from Tauri range |
| MCP bridge | 9223–9322 | Plugin auto-scans; we discover after launch |

## Step 1: Detect what changed (change verification mode only)

Collect all changed files — last commit, staged, and unstaged:

```bash
{ git diff --name-only HEAD~1 HEAD 2>/dev/null; git diff --name-only --cached; git diff --name-only; } | sort -u
```

If no changes at all, tell the user and stop.

Categorize changed files into ALL matching categories:

| Pattern | Category |
|---|---|
| `src/**/*.svelte`, `src/**/*.ts` (not test files) | frontend (check if files import `@tauri-apps/*` or `invoke` → also mark as tauri-dependent) |
| `src/**/*.css`, `src/styles/**` | styles |
| `src/**/*.test.ts`, `src/**/*.spec.ts` | unit-tests |
| `crates/futo-notes-server/**` (not Dockerfile/docker-compose) | server |
| `crates/futo-notes-server/Dockerfile`, `docker-compose*` | server-docker |
| `apps/tauri/src-tauri/**` | tauri-rust |
| `apps/cli/**` | cli |
| `packages/shared/**` | shared |
| `tests/**` | playwright-tests |
| `.gitlab-ci.yml` | ci |

A change can match multiple categories. Run ALL matching chains.

## Step 2: Run verification chains

Run the build once upfront if any chain needs it (frontend, styles, or unit-tests), then run test suites. Stop and report on first failure.

### Always (unless only CI files changed):
```bash
pnpm exec tsc --noEmit 2>&1 | head -30
```
If type errors → stop and report.

### frontend, styles, or unit-testable logic:
Build once (don't repeat if multiple categories match):
```bash
pnpm run build 2>&1 | tail -20
```

### frontend or styles — Playwright specs:
Find relevant specs by grepping for keywords related to the change:
```bash
grep -rl '<feature-keyword>' tests/*.spec.ts
```
Run matching specs, or if unsure run all:
```bash
pnpm run test 2>&1 | tail -40
```

### server:
```bash
pnpm run server:test 2>&1 | tail -30
```

### server-docker:
After server tests pass:
```bash
docker compose -f crates/futo-notes-server/docker-compose.yml up --build -d 2>&1 | tail -20
sleep 3 && curl -sf http://localhost:3005/health && echo "OK" || echo "FAIL"
docker compose -f crates/futo-notes-server/docker-compose.yml down 2>&1
```

### dashboard:
After server tests pass, smoke-test the server. Start a temp server (`PORT=3005 DATA_DIR=$(mktemp -d) FUTO_NOTES_DEV_PASSWORD=testing123 cargo run -p futo-notes-server &`), run the auth flow via curl (setup → login → authenticated endpoint → verify unauthenticated 401), then kill the process.

### shared:
```bash
pnpm run test:shared 2>&1 | tail -20
```

### unit-tests or other unit-testable logic:
```bash
pnpm run test:unit 2>&1 | tail -30
```

### tauri-rust:
```bash
pnpm run tauri:test:rust 2>&1 | tail -30
```

### cli:
```bash
cd apps/cli && cargo check 2>&1 | tail -10
cd apps/cli && cargo test 2>&1 | tail -20
```

### ci:
Check latest pipeline for the current branch:
```bash
BRANCH=$(git branch --show-current)
curl -s --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "https://gitlab.futo.org/api/v4/projects/justin%2Ffuto-notes/pipelines?ref=$BRANCH&per_page=1"
```

## Step 3: UI Verification

When changes affect anything user-facing, or when verifying a user-facing feature, visually verify in the actual app. Skip for test-only or CI-only changes.

**"Invisible" behavior still needs UI verification.** Fire-and-forget network calls, background warmups, prefetches, preloads — anything with no visible UI change — must still be verified in the running app. Use `webview_execute_js` to check network activity, inspect console logs via `read_logs`, or check server logs to confirm the request actually fires. "No UI change" is not a reason to skip; it means you verify via a different signal. For server-side changes (new routes, modified responses), launch the app and confirm the client actually hits the new endpoint.

```bash
mkdir -p ./test-screenshots
```

### Choosing web vs Tauri

The web dev server stubs out all Tauri commands — it cannot exercise any code path that flows through Rust `#[tauri::command]` handlers, native file system operations, `@tauri-apps/*` plugin APIs, or platform-specific behavior. Many frontend files in this codebase depend on Tauri APIs (`invoke()`, `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-clipboard-manager`, etc.).

**Use the Tauri desktop app when ANY of these are true:**
- `tauri-rust` is in the detected categories (Rust backend changed)
- Changed frontend files import from `@tauri-apps/*`, call `invoke()`, or use `rustCore`
- The feature involves file I/O, native dialogs, clipboard, window management, titlebar, or any platform API
- The user says "desktop", "Tauri", or "native"
- You're unsure whether the feature depends on Rust — default to Tauri

Check quickly with:
```bash
# Do any changed frontend files depend on Tauri APIs?
grep -rl 'invoke\|@tauri-apps\|rustCore' $(git diff --name-only HEAD~1 HEAD 2>/dev/null; git diff --name-only --cached; git diff --name-only) 2>/dev/null | grep -E '\.(ts|svelte)$' | sort -u
```
If any files match → use Tauri. If none match and changes are purely CSS/markdown/CodeMirror decorations → web is acceptable.

**Use the web dev server ONLY when:**
- Changes are purely CSS / Tailwind styling
- Changes are purely CodeMirror decorations / markdown rendering (no Tauri API calls)
- No Rust changes involved
- The feature works identically with platform stubs

### Desktop (Web — CSS/markdown-only fast path)

Uses `agent-browser` (Rust CLI) — faster than Playwright MCP, handles CodeMirror typing natively, and supports annotated screenshots with element labels.

1. Start the dev server on the worktree-specific port, then open in agent-browser:
```bash
# Re-compute instance variables (see Instance Setup)
WORKTREE_ROOT="$(git rev-parse --show-toplevel)"
SLOT=$(( $(printf "%d" "0x$(echo -n "$WORKTREE_ROOT" | md5sum | cut -c1-8)") % 50 ))
WEB_VITE_PORT=$(( 5250 + SLOT ))

pnpm run dev -- --port $WEB_VITE_PORT --strictPort &
VITE_PID=$!
sleep 4
agent-browser open http://localhost:$WEB_VITE_PORT
```

2. Interact via agent-browser CLI:
```bash
agent-browser snapshot -i          # Interactive elements only, with @refs
agent-browser snapshot -i -c       # Compact (one line per element)
agent-browser click @e7            # Click by ref
agent-browser fill @e10 "text"     # Fill an input
agent-browser type @e11 "text"     # Type into contenteditable (works with CM6)
agent-browser screenshot ./test-screenshots/web-<description>.png
agent-browser screenshot --annotate ./test-screenshots/web-<description>.png  # With numbered labels
agent-browser eval 'document.querySelector("[data-wikilink]").click()'        # Run JS
```

3. Clean up:
```bash
agent-browser close
kill $VITE_PID 2>/dev/null
```

### Desktop (Tauri — the default for most features)

This is the real app. Use it whenever the feature touches platform APIs, Rust commands, or anything beyond pure CSS/markdown rendering. The app has `tauri-plugin-mcp-bridge` installed (debug builds only), which exposes the Tauri MCP tools for direct webview interaction. The MCP bridge auto-scans ports 9223–9322 so multiple instances coexist.

1. Check for an already-running instance from this worktree, or kill stale and launch fresh:
```bash
# Re-compute instance variables (see Instance Setup)
WORKTREE_ROOT="$(git rev-parse --show-toplevel)"
SLOT=$(( $(printf "%d" "0x$(echo -n "$WORKTREE_ROOT" | md5sum | cut -c1-8)") % 50 ))
VITE_PORT=$(( 5200 + SLOT ))
TAURI_LOG="/tmp/tauri-verify-${SLOT}.log"
PID_FILE="/tmp/tauri-verify-${SLOT}.pid"

# Check if this worktree already has a running instance
ALREADY_RUNNING=false
if [ -f "$PID_FILE" ]; then
  CARGO_PID=$(cat "$PID_FILE")
  if kill -0 "$CARGO_PID" 2>/dev/null; then
    echo "Tauri already running for this worktree (PID $CARGO_PID)"
    ALREADY_RUNNING=true
  else
    rm -f "$PID_FILE"
  fi
fi

if [ "$ALREADY_RUNNING" = false ]; then
  # Kill stale instance for THIS worktree only (not other worktrees)
  if [ -f "$PID_FILE" ]; then
    CARGO_PID=$(cat "$PID_FILE")
    kill -- -$(ps -o pgid= "$CARGO_PID" | tr -d ' ') 2>/dev/null
    rm -f "$PID_FILE"
    sleep 2
  fi

  # Launch with worktree-specific Vite port and unique identifier.
  # The `s` prefix on the slot is required: D-Bus well-known names cannot have
  # segments starting with a digit, and tauri-plugin-single-instance panics if
  # the identifier violates this (e.g., `.47` fails, `.s47` works).
  # NOTE: Use Bash tool's `run_in_background` parameter instead of shell `&` —
  # `$!` does not expand correctly inside the Bash tool.
  cd "$WORKTREE_ROOT/apps/tauri" && \
    WINIT_UNIX_BACKEND=wayland GDK_BACKEND=wayland WEBKIT_DISABLE_DMABUF_RENDERER=1 \
    cargo tauri dev \
      --config src-tauri/tauri.dev.conf.json \
      --config '{"identifier":"com.futo.notes.verify.s'"$SLOT"'","build":{"beforeDevCommand":"npm run dev --prefix ../.. -- --host 127.0.0.1 --port '"$VITE_PORT"' --strictPort","devUrl":"http://127.0.0.1:'"$VITE_PORT"'"}}' \
    > "$TAURI_LOG" 2>&1 &
  echo $! > "$PID_FILE"
  # First build is slow (~60s), rebuilds are faster (~20s)
fi
```

Discover the MCP bridge port from the log (the plugin prints its actual port on startup):
```bash
TAURI_LOG="/tmp/tauri-verify-${SLOT}.log"
for i in $(seq 1 90); do
  MCP_PORT=$(grep -oP "initialized for .* on [^:]+:\K\d+" "$TAURI_LOG" 2>/dev/null | tail -1)
  [ -n "$MCP_PORT" ] && echo "MCP bridge ready on port $MCP_PORT" && break
  sleep 2
done

# Fallback: scan for the Tauri process listening in the MCP port range
if [ -z "$MCP_PORT" ]; then
  TAURI_PID=$(pgrep -f "futo-notes-tauri" --newest 2>/dev/null)
  if [ -n "$TAURI_PID" ]; then
    MCP_PORT=$(ss -tlnp 2>/dev/null | grep "pid=$TAURI_PID" | grep -oP ':\K(92[2-9]\d|93[01]\d|932[0-2])' | head -1)
  fi
fi
echo "Using MCP bridge port: $MCP_PORT"
```

2. Connect via Tauri MCP tools — pass the discovered port:
   - `driver_session` with action `start` and **`port` set to the discovered `$MCP_PORT`** (do NOT hardcode 9223)
   - `webview_dom_snapshot` (type: accessibility) to see the current UI state with element refs
   - `webview_interact` to click, scroll, swipe elements (by CSS selector, text, or ref ID)
   - `webview_keyboard` to type text or press keys (for CodeMirror, use `webview_execute_js` with `document.execCommand('insertText', false, 'text')` since CM6 in WebKit doesn't respond to synthetic key events)
   - `webview_screenshot` to capture screenshots — use `filePath` to save to `./test-screenshots/desktop-<description>.png`
   - `webview_execute_js` to run JavaScript in the real app context (has access to `window.__TAURI__`)
   - `webview_find_element` to locate elements by CSS, XPath, or text

   Note: Native Tauri dialogs (`@tauri-apps/plugin-dialog`) are NOT in the DOM. Use coordinate-based `webview_interact` clicks based on screenshot positions to interact with them.

3. Clean up — kill only THIS worktree's processes:
   - `driver_session` with action `stop`
   - Then kill the process tree:
```bash
WORKTREE_ROOT="$(git rev-parse --show-toplevel)"
SLOT=$(( $(printf "%d" "0x$(echo -n "$WORKTREE_ROOT" | md5sum | cut -c1-8)") % 50 ))
PID_FILE="/tmp/tauri-verify-${SLOT}.pid"
if [ -f "$PID_FILE" ]; then
  CARGO_PID=$(cat "$PID_FILE")
  kill -- -$(ps -o pgid= "$CARGO_PID" | tr -d ' ') 2>/dev/null
  rm -f "$PID_FILE" "/tmp/tauri-verify-${SLOT}.log"
fi
```

### Android

Use when verifying Android-specific behavior or when the user asks. The app includes `tauri-plugin-mcp-bridge` (debug builds), so the same Tauri MCP tools used for desktop work on Android — no coordinate guessing or raw `adb` taps needed.

1. Check device/emulator is connected. **If none is connected, start one automatically:**
```bash
DEVICE_COUNT=$(adb devices 2>/dev/null | grep -v "^List" | grep -c "device$")
if [ "$DEVICE_COUNT" -eq 0 ]; then
  echo "No Android device/emulator found. Starting emulator..."
  # Pick the first available AVD
  AVD_NAME=$($ANDROID_HOME/emulator/emulator -list-avds 2>/dev/null | head -1)
  if [ -z "$AVD_NAME" ]; then
    echo "FAIL: No AVDs available. Create one with Android Studio or avdmanager."
  else
    echo "Launching AVD: $AVD_NAME"
    $ANDROID_HOME/emulator/emulator -avd "$AVD_NAME" -no-snapshot-load &
    EMULATOR_PID=$!
    # Wait for the emulator to boot (up to 120s)
    echo "Waiting for emulator to boot..."
    for i in $(seq 1 60); do
      BOOT=$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
      [ "$BOOT" = "1" ] && echo "Emulator booted (${i}x2s)" && break
      sleep 2
    done
    BOOT=$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
    [ "$BOOT" != "1" ] && echo "FAIL: Emulator did not boot in time"
  fi
else
  echo "Android device/emulator connected ($DEVICE_COUNT)"
fi
adb devices | grep -v "^List"
```

2. Build and deploy:
```bash
pnpm run build 2>&1 | tail -5
cd apps/tauri && CARGO_TAURI_CLI_NO_DEV_SERVER=1 cargo tauri android build --debug --apk 2>&1 | tail -10
adb install -r apps/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```
If install fails with `INSTALL_FAILED_INSUFFICIENT_STORAGE`, uninstall a previous build first (`adb shell pm uninstall com.futo.notes` or a variant like `com.futo.notes.claude`).

3. Launch and wait for MCP bridge:
```bash
adb shell am force-stop com.futo.notes
adb shell monkey -p com.futo.notes -c android.intent.category.LAUNCHER 1
sleep 4
adb shell pidof com.futo.notes  # confirm running
```

4. Connect the Tauri MCP bridge. The bridge plugin runs inside the Android WebView and listens on a local socket. Forward its port to localhost, then connect:
```bash
# Kill this worktree's stale desktop Tauri process if it holds port 9223
WORKTREE_ROOT="$(git rev-parse --show-toplevel)"
SLOT=$(( $(printf "%d" "0x$(echo -n "$WORKTREE_ROOT" | md5sum | cut -c1-8)") % 50 ))
PID_FILE="/tmp/tauri-verify-${SLOT}.pid"
if [ -f "$PID_FILE" ]; then
  CARGO_PID=$(cat "$PID_FILE")
  kill -- -$(ps -o pgid= "$CARGO_PID" | tr -d ' ') 2>/dev/null
  rm -f "$PID_FILE" "/tmp/tauri-verify-${SLOT}.log"
  sleep 1
fi
# Forward the Android app's MCP bridge port
adb forward tcp:9223 tcp:9223
```
Then use the MCP tools:
   - `driver_session` with action `start` (port 9223) to connect
   - `webview_dom_snapshot` (type: accessibility) — returns a YAML tree with `[ref=eN]` IDs for every interactive element. Use this to find buttons, inputs, and other elements **by name** instead of guessing coordinates.
   - `webview_interact` — click, scroll, swipe by ref ID, CSS selector, or text. Example: click `ref=e12` or selector `.for-you-browse-btn`. Never use raw `adb shell input tap` coordinates.
   - `webview_screenshot` — capture to a file path: `filePath: ./test-screenshots/android-<description>.png`
   - `webview_execute_js` — run JS in the real app context to inspect internal state (e.g., check Svelte component state via DOM attributes or class lists). Use IIFE syntax: `(() => { return value; })()`
   - `webview_find_element` — find elements by CSS selector, XPath, or text content
   - `webview_keyboard` — type text or send key events
   - `read_logs` with source `console` — read webview JS console logs (errors, warnings, app logs). Also supports source `android` for logcat.
   - `webview_wait_for` — wait for a selector, text, or IPC event before proceeding

5. Clean up:
   - `driver_session` with action `stop`
   - Then:
```bash
adb shell am force-stop com.futo.notes
adb forward --remove tcp:9223 2>/dev/null
```

**Important Android MCP notes:**
- The MCP bridge operates inside the WebView, so it sees the same DOM as the user. It cannot interact with native Android UI outside the WebView (e.g., system permission dialogs).
- `adb shell input tap` is unreliable for WebView content — coordinates don't map 1:1 due to device pixel ratio and viewport offsets. Always prefer `webview_interact` with selectors or ref IDs.
- If the MCP bridge port (9223) is blocked by a stale desktop Tauri process, kill it using the PID file for the current worktree (see cleanup pattern above).
- For video recording (e.g., animation verification), use `adb shell screenrecord` — the MCP tools don't support video capture.

### Windows (WebView2 — qemu VM)

Use when verifying **Windows-only behavior on real WebView2** that the web/WebKit/Chromium paths and the Linux Tauri build cannot exercise: native drag-and-drop (e.g. dragging a note onto a folder — wry's `dragDropEnabled` swallows HTML5 DnD on WebView2), the NSIS installer, clean-machine launch (VC++/WebView2 runtime), or any `#[cfg(windows)]` path. Playwright/agent-browser run in WebKit/Chromium, **NOT WebView2**, so a green E2E does not prove Windows behavior.

The harness scripts live in the repo at **`scripts/win-vm/`** (`launch-vm.sh`, `vmctl.py`, `record_drag.py`) — see **`scripts/win-vm/README.md`** for the full quick-start and the tooling decisions. Raw `qemu-system-x86_64` (world-writable `/dev/kvm`, no libvirt/sudo) with UEFI + emulated TPM 2.0 and a QMP control socket for screenshots/keyboard/mouse/drag. The heavy data dir (ISOs, disk, frames) is `$WIN_VM_DIR` (default `~/Developer/win-vm`), kept out of the repo.

**Stage the build under test.** CI builds the signed NSIS `.exe` on git tags only (`windows:sign` job in `.gitlab-ci.yml`). Download that tag's artifact and rebuild the app ISO:
```bash
export WIN_VM_DIR=~/Developer/win-vm
cp "FUTO Notes_<ver>_x64-setup.exe" "$WIN_VM_DIR/appiso/futo-setup.exe"
genisoimage -quiet -o "$WIN_VM_DIR/app.iso" -J -r -V FUTOAPP "$WIN_VM_DIR/appiso/"
```
(The Win11 ISO must be fetched once via a **real browser** — `agent-browser` works — because Microsoft IP-blocks scripted ISO downloads. virtio + the quickget `autounattend.xml` are already staged.)

**Run + drive:**
```bash
scripts/win-vm/launch-vm.sh > "$WIN_VM_DIR/run/qemu.log" 2>&1 &   # Bash run_in_background
for i in $(seq 1 30); do [ -S "$WIN_VM_DIR/run/qmp.sock" ] && break; sleep 1; done
python3 scripts/win-vm/vmctl.py key ret   # one-time "press any key to boot from CD"; tap 2-3x
# Always screenshot first and read pixel coords off it:
python3 scripts/win-vm/vmctl.py shot "$WIN_VM_DIR/run/shots/NN.png"
python3 scripts/win-vm/vmctl.py key meta_l r                 # Win+R
python3 scripts/win-vm/vmctl.py type "G:\\futo-setup.exe /S" # silent NSIS install
python3 scripts/win-vm/vmctl.py drag X1 Y1 X2 Y2             # HTML5-DnD-friendly drag
```
Watch live via VNC on `localhost:5910` (e.g. `vlc vnc://localhost:5910`).

**Procedure:** boot → unattended install (auto-login `Quickemu`/`quickemu`; the modern 25H2 setup needs one click past the keyboard screen, then `autounattend.xml` takes over — do NOT press keys on later reboots) → silent app install from G: → launch → create a folder + a root note → drag the note onto the folder → screenshot **and** verify on disk (`C:\Users\Quickemu\Documents\futo-notes\<Folder>\<Note>.md`, gone from root).

**Gotchas:** a clean Win11 lacks the MSVC runtime — without the bundled vc_redist the app dies on launch with `MSVCP140_1.dll not found`. Win11 25H2 ships the WebView2 runtime, so the editor renders.

**Video recording** (QMP has no native capture — `record_drag.py` grabs frames over one connection, then ffmpeg stitches):
```bash
python3 scripts/win-vm/record_drag.py X1 Y1 X2 Y2
ffmpeg -y -framerate 10 -pattern_type glob -i "$WIN_VM_DIR/run/frames/*.png" \
  -vf "scale=1280:-2,format=yuv420p" "$WIN_VM_DIR/run/verify-drag.mp4"
```

### Handling loading/async states in screenshots

After taking a screenshot, inspect it for loading or computing states (spinners, "Computing...", "Loading...", progress indicators). If a loading state is visible:

1. Wait 5 seconds, re-screenshot
2. Repeat up to 6 times (30 seconds total)
3. If the state resolves, capture the final rendered state — that's the screenshot that matters
4. If still loading after 30 seconds, report it as **STUCK** in the verification table and investigate (check console logs via `webview_execute_js` or `read_logs`)

A screenshot showing only a loading state does not count as verification. Every changed feature needs at least one screenshot showing the **actual rendered UI**, not a transient state.

### Verifying features that require app restart

Some features only manifest after an app restart (e.g., crash dialog appears on launch after a crash was captured, preferences recovery from backup). For these:

1. Trigger the precondition (e.g., fire a test crash, corrupt a file)
2. Kill the Tauri process (using the PID file cleanup pattern)
3. Relaunch the app (same launch command as initial setup)
4. Wait for MCP bridge to reconnect
5. Screenshot the result

Don't skip restart-dependent features — they're often the ones most likely to break.

### Verifying features that need a sync server

Many features require a running sync server with data (graph/indexing, sync dedup, SSE notifications). When verification touches sync, indexing, or graph, stand up an isolated server:

```bash
WORKTREE_ROOT="$(git rev-parse --show-toplevel)"
SLOT=$(( $(printf "%d" "0x$(echo -n "$WORKTREE_ROOT" | md5sum | cut -c1-8)") % 50 ))
VERIFY_SERVER_PORT=$(( 3100 + SLOT ))
VERIFY_SERVER_DIR=$(mktemp -d /tmp/futo-notes-verify-server-XXXXXX)

# Start an isolated Rust server with its own data dir
cd "$WORKTREE_ROOT"
PORT=$VERIFY_SERVER_PORT \
  DATA_DIR="$VERIFY_SERVER_DIR" \
  FUTO_NOTES_DEV_PASSWORD=testing123 \
  cargo run -p futo-notes-server > "$VERIFY_SERVER_DIR/server.log" 2>&1 &
VERIFY_SERVER_PID=$!
echo $VERIFY_SERVER_PID > "$VERIFY_SERVER_DIR/server.pid"
sleep 3

# Confirm server is healthy
curl -sf http://localhost:$VERIFY_SERVER_PORT/health && echo " Server OK on port $VERIFY_SERVER_PORT" || echo " FAIL"
```

Then in the Tauri app, connect to `http://localhost:$VERIFY_SERVER_PORT` with a test password (at least 8 chars). After connecting + syncing:
1. Verify notes sync (check count in toast)
2. Wait for indexing to complete (check `GET /search/status` — phase should reach `idle` with dirty count 0)
3. Open graph — should render with actual nodes, not just "Computing..."
4. Verify the specific feature being tested

Clean up the server when done:
```bash
VERIFY_SERVER_DIR=$(ls -d /tmp/futo-notes-verify-server-* 2>/dev/null | head -1)
if [ -n "$VERIFY_SERVER_DIR" ] && [ -f "$VERIFY_SERVER_DIR/server.pid" ]; then
  kill $(cat "$VERIFY_SERVER_DIR/server.pid") 2>/dev/null
  rm -rf "$VERIFY_SERVER_DIR"
fi
```

### What to look for

Focus on what changed or the specific feature being verified. Common checks:
- **Editor**: Open a note, type text, verify decorations/widgets render correctly
- **Theme/styles**: Toggle light/dark, check contrast, verify no broken layouts
- **Navigation**: Sidebar, note switching, back/forward, search
- **Settings**: Open settings, toggle options, verify they persist after reload
- **Crash dialog**: Trigger a test crash → restart the app → verify the dialog appears, Copy button works, overlay doesn't dismiss
- **Sync/graph/indexing**: Stand up isolated server → connect client → sync → wait for index → verify graph renders
- **New features**: Exercise the happy path, then try one edge case
- **Invisible behavior** (warmups, prefetches, fire-and-forget calls): Open the relevant UI surface, then check server logs or use `webview_execute_js` / `read_logs` to confirm the request actually fired. Example: for a search warmup, open the search popup and check the server log for the warmup request

Name screenshots descriptively: `web-editor-heading-decoration.png`, `android-dark-theme-sidebar.png`, `desktop-settings-panel-open.png`.

## Step 4: Report

Summarize everything in a table. Include commands run, pass/fail, and key observed behavior.

```
| Check          | Result | Notes                         |
|----------------|--------|-------------------------------|
| TypeScript     | PASS   |                               |
| Build          | PASS   |                               |
| Server tests   | PASS   | 239/239 passing               |
| Unit tests     | PASS   | 42/42 passing                 |
| Tauri Rust     | SKIP   | no Rust changes               |
| Shared         | SKIP   | no shared changes             |
| UI (desktop)   | PASS   | 3 screenshots in test-screenshots/ |
| UI (android)   | SKIP   | no device connected           |
```

If anything failed, show the relevant error output and suggest a fix.

List screenshots/recordings taken with a brief description of what each shows.

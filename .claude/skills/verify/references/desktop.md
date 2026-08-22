# Desktop — web fast path and the Tauri app

Two ways to see a change running on desktop. The web dev server is faster but
stubs out every Tauri command; the Tauri app is the real thing. When in doubt,
use Tauri. Both need the Instance Setup variables from SKILL.md (`$SLOT`,
`$VITE_PORT`, `$WEB_VITE_PORT`, `$TAURI_LOG`, `$PID_FILE`) — re-compute them
in every Bash block.

## CRITICAL — never send OS-level input, never resolve the app by name (M24)

The user's installed release app runs on this machine, on their real vault
(`~/Documents/futo-notes`, live E2EE sync). Two habits reach it by accident:

- **OS-level input** (AppleScript UI scripting, `cliclick`, `xdotool`) is
  delivered to whatever the window server thinks is FOCUSED. It is not
  addressed to the process you picked, so no care in picking one makes it safe.
  On 2026-08-10 a QA agent sent real Cmd+Z keystrokes this way; they landed in
  the production app. Drive the **webview bridge** below instead — it can only
  reach the instance you connected to. If the bridge cannot do it, the story is
  BLOCKED, not "worth one keystroke".
- **Name/PID lookup.** Every build ships the same binary name, release included
  (`/Applications/FUTO Notes.app/Contents/MacOS/futo-notes-tauri` really is that
  name), and parallel worktrees add more. The only sanctioned resolver is:

```bash
node scripts/qa-target.mjs list          # every instance, classified
node scripts/qa-target.mjs port 9231     # verify whoever listens there → exit 3 if unsafe
node scripts/qa-target.mjs pid 4321      # verify one PID
node scripts/qa-target.mjs kill          # stop THIS worktree's instances only
```

It verifies the real executable path against this repo's worktree list plus the
instance's own data dir and vault, and refuses everything else — emphatically
an installed bundle. Exit 3 means _stop_, not "try harder". `scripts/check-qa-input-safety.mjs`
fails the build if either habit reappears in an instruction file.

One more measurement trap from the same incident: on BSD/macOS `find -newermt`
with a **relative** time ("-24 hours") silently matches nothing instead of
erroring, so a vault-safety check written that way reports a false all-clear.
Use `touch -t <absolute stamp> /tmp/ref` plus `find … -newer /tmp/ref`.

## Web (CSS/markdown-only fast path)

Only for changes that work identically with platform stubs: pure CSS/Tailwind,
CodeMirror decorations, markdown rendering. Anything touching `invoke()`,
`@tauri-apps/*`, `rustCore`, file I/O, dialogs, clipboard, or window
management needs the Tauri app instead.

Uses `agent-browser` (Rust CLI) — faster than Playwright MCP, types into
CodeMirror natively, and annotates screenshots. Run `agent-browser` with no
args for the full command reference.

```bash
pnpm run dev -- --port $WEB_VITE_PORT --strictPort &   # use Bash run_in_background
sleep 4
agent-browser open http://localhost:$WEB_VITE_PORT

agent-browser snapshot -i -c          # interactive elements, one line each, with @refs
agent-browser click @e7
agent-browser fill @e10 "text"        # inputs
agent-browser type @e11 "text"        # contenteditable (works with CM6)
agent-browser screenshot --annotate ./test-screenshots/web-<description>.png
agent-browser eval 'document.querySelector("[data-wikilink]").click()'

agent-browser close                    # cleanup (and kill the dev server)
```

## Tauri desktop (the default)

Debug builds include `tauri-plugin-mcp-bridge`, exposing the Tauri MCP tools
(`driver_session`, `webview_*`). The bridge binds **loopback only** and scans
upward from a per-worktree base port (`scripts/lib/slot.mjs` -> `mcp`, passed as
`FUTO_MCP_BASE_PORT` by `just tauri-dev`), so worktree instances coexist without
contending for one port. Bases land in 9223–9272 and the scan runs 100 ports up,
so 9223–9322 is still the range to sweep.

Print this worktree's base with `just ports`. Loopback-only matters: the plugin
used to bind `0.0.0.0`, which succeeds even while another process holds
`127.0.0.1:<port>` — so it logged a port that every client (all of which dial
127.0.0.1) resolved to the OTHER process.

### Launch (or reuse a running instance)

<!-- The config path below is relative to the cd into apps/tauri a few lines into this same script, not repo-root — the checker can't see that shell context. -->
<!-- check-agent-docs: ignore-next-block -->

```bash
# Re-compute instance variables (see SKILL.md Instance Setup)
ALREADY_RUNNING=false
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Tauri already running for this worktree (PID $(cat "$PID_FILE"))"
  ALREADY_RUNNING=true
fi

if [ "$ALREADY_RUNNING" = false ]; then
  rm -f "$PID_FILE"
  # The env vars are Linux/Wayland-specific and harmless on macOS.
  # The `s` prefix on the slot is required: D-Bus well-known names cannot have
  # segments starting with a digit; tauri-plugin-single-instance panics on
  # `.47`, accepts `.s47`.
  # NOTE: use Bash run_in_background instead of shell `&` — `$!` does not
  # expand correctly inside the Bash tool.
  # FUTO_NOTES_DATA_DIR isolates notes/app data per worktree — the debug
  # default (~/Documents/fake-notes) is machine-global and would be shared
  # by parallel sessions.
  cd "$WORKTREE_ROOT/apps/tauri" && \
    WINIT_UNIX_BACKEND=wayland GDK_BACKEND=wayland WEBKIT_DISABLE_DMABUF_RENDERER=1 \
    FUTO_NOTES_DATA_DIR="$WORKTREE_ROOT/.tauri-data" \
    cargo tauri dev \
      --config src-tauri/tauri.dev.conf.json \
      --config '{"identifier":"com.futo.notes.verify.s'"$SLOT"'","build":{"beforeDevCommand":"npm run dev --prefix ../.. -- --host 127.0.0.1 --port '"$VITE_PORT"' --strictPort","devUrl":"http://127.0.0.1:'"$VITE_PORT"'"}}' \
    > "$TAURI_LOG" 2>&1 &
  echo $! > "$PID_FILE"
  # First build ~60s; rebuilds ~20s.
fi
```

### Discover the MCP bridge port

The plugin prints its port on startup. (Plain `sed` — BSD/macOS grep has no
`-P`, don't use `grep -oP` here.)

```bash
for i in $(seq 1 90); do
  MCP_PORT=$(sed -n 's/.*initialized for .* on [^:]*:\([0-9][0-9]*\).*/\1/p' "$TAURI_LOG" 2>/dev/null | tail -1)
  [ -n "$MCP_PORT" ] && echo "MCP bridge ready on port $MCP_PORT" && break
  sleep 2
done

# Fallback — scan the bridge port range and let the resolver vet the owner.
# NEVER find the process by name: every build shares it, release included.
if [ -z "$MCP_PORT" ]; then
  for CANDIDATE in $(seq 9223 9322); do
    if node scripts/qa-target.mjs port "$CANDIDATE" >/dev/null 2>&1; then
      MCP_PORT=$CANDIDATE; break
    fi
  done
fi
echo "Using MCP bridge port: $MCP_PORT"
```

`qa-target.mjs port` exits 0 only for a debug build owned by this worktree, so
the loop cannot settle on the release app or on a sibling worktree's instance.
Run it once by hand (`node scripts/qa-target.mjs list`) if the loop finds
nothing — the refusal reason tells you what is actually running.

### Interact

Connect `driver_session` with action `start` and **`port` = the discovered
`$MCP_PORT`** (never hardcode 9223). Then:

- `webview_dom_snapshot` (type: accessibility) — UI state with `[ref=eN]` ids
- `webview_interact` — click/scroll/swipe by ref, CSS selector, or text
- `webview_keyboard` — type/press keys. For CodeMirror, use
  `webview_execute_js` with `document.execCommand('insertText', false, 'text')`
  — CM6 in WebKit ignores synthetic key events.
- `webview_screenshot` — save to `./test-screenshots/desktop-<description>.png`
- `webview_execute_js` — full app context, `window.__TAURI__` available
- `read_logs` (source: console) — webview JS console

Native Tauri dialogs (`@tauri-apps/plugin-dialog`) are **not in the DOM** —
click them by screenshot coordinates via `webview_interact`.

Dev-only sync hooks in this webview: `window.__testSync.connect(url, password)`
/ `.status()` / `.syncNow()` / `.disconnect()` / `.pauseAutoSync()` /
`.resumeAutoSync()` (`src/features/sync/testSync.ts`) — prefer these over UI
automation when switching sync servers.

### No MCP tools? Raw WebSocket fallback

Fresh sessions and background jobs often don't have the Tauri MCP tools
registered. The bridge is a plain WebSocket server on the port you discovered
above — send `{"id":"r1","command":"…","args":{…}}`, receive
`{"id","success","data"}`. Commands: `execute_js` (`args:{script}`; async
IIFEs are awaited), `capture_native_screenshot` (returns a base64 data URL),
`list_windows`, `invoke_tauri`. Node ≥21's built-in WebSocket needs no deps:

```bash
MCP_PORT=$MCP_PORT node <<'EOF'
const ws = new WebSocket(`ws://127.0.0.1:${process.env.MCP_PORT}`);
ws.onopen = () => ws.send(JSON.stringify({ id: 'r1', command: 'execute_js',
  args: { script: '(async () => await window.__testSync.status())()' } }));
ws.onmessage = (m) => { console.log(m.data); ws.close(); };
EOF
```

Gotchas: (1) `execute_js` has a ~2–3s server-side timeout, but the script
**keeps running in the webview** after the timeout error — never assume a
timed-out script didn't execute; for longer work, stash results on
`window.__x` and collect them with a second call. (2) Vite module singletons
are importable — `await import('/src/lib/foo.svelte.ts')` returns the same
instance the app uses. (3) Killing a backgrounded `tauri dev` task can orphan
the debug binary, which keeps its bridge port and pushes the next launch to the
next port — `node scripts/qa-target.mjs kill` (this worktree's instances only)
and re-check with `node scripts/qa-target.mjs list`.

### Reaching the app's real editor module state

Some checks need the app's own CodeMirror instance — `undoDepth`, `undo()`,
`EditorState` internals — not a fresh copy. This is the alternative to OS
keystrokes, and it is strictly better: no input, no focus, no cross-app risk.

Module identity is keyed by URL, so import the **already-loaded** dep chunk:

```js
const url = performance
  .getEntriesByType('resource')
  .map((entry) => entry.name)
  .find((name) => /@codemirror_commands/.test(name));
const commands = await import(url); // the app's live instance
commands.undoDepth(window.__editorView.state);
```

A plain `import('@codemirror/commands')` resolves to a _different_ module
instance whose `historyField` is not the app's, which is why depth reads come
back 0 and undo appears to do nothing. Same trick for any dep the app loaded.

### Screenshots without stealing focus

Several sessions QA this app in parallel on one Mac, and the human is usually
typing in a terminal on another space. Anything that activates an app — `open -a`,
or the window-raise below — yanks them mid-sentence. Treat activation as a cost
you justify, not a default.

You almost never need it: a window's surface stays live and current while it
sits on another space, so capture it where it is.

| Situation                                 | Use                                                       |
| ----------------------------------------- | --------------------------------------------------------- |
| Live bridge (the normal case)             | `capture_native_screenshot` — ~19 ms, no extra permission |
| No bridge, or an unknown/dead bridge port | `just qa-shot pid <pid>` \| `port <port>` \| `list`       |
| iOS simulator content                     | `just sim-screenshot` (`simctl` needs no foreground app)  |

`just qa-shot` captures by window id (`screencapture -l`), which is why it
reaches a window on another space — that window is not "on screen", so a naive
enumeration misses it and tempts you into activating the app to make it appear.
It refuses any process `qa-target.mjs` will not verify as this worktree's debug
build: a capture reads pixels, and the release app's window shows the user's
real vault (M24).

`just sim-boot` no longer foregrounds Simulator.app. Pass `SHOW=1` when a human
wants to watch, or for the frame-dependent case below.

### Frame-dependent measurements need a VISIBLE window

WebKit suspends `requestAnimationFrame` while the window is occluded, so any
probe that awaits a frame (`scripts/perf/tab-switch-probe.js`, anything measuring
paint) hangs rather than fails — budget a wall-clock timeout around every frame
wait of your own. `document.visibilityState` is the check;
`document.hasFocus()` can be `true` while the page is `hidden`.

The webview cannot raise itself: `getCurrentWindow().setFocus()` is denied
(`core:window:allow-set-focus`). Launch a second copy of the same debug binary
instead — `tauri-plugin-single-instance`'s handler calls `window.set_focus()`
from Rust, which no capability gates, and the second process exits immediately:

```bash
FUTO_NOTES_DATA_DIR="$WORKTREE_ROOT/.tauri-data" \
  "$WORKTREE_ROOT/target/debug/futo-notes-tauri" >/dev/null 2>&1
```

Parallel sessions steal focus back within seconds, so arm the measurement on
`visibilitychange` (or re-run that command in a 1s loop for the run's duration)
and record `visibilityState` in the result so a stolen-focus run is discardable
rather than silently wrong.

This raise is the one thing in this file that legitimately takes the screen from
the user, so keep it scoped to measurements that actually await a frame — never
to "see" the app, which the capture options above do without disturbing anyone.
On a single-display machine there is no way to make it polite; a second display
(a real one, or a virtual/dummy display) is what buys an unoccluded window that
nobody is looking at.

### What the DOM says is not what the screen shows

For scroll/animation defects, in-page sampling can be structurally blind:
`getBoundingClientRect` reports geometry against the **main thread's** scroll
offset, while WebKit scrolls this container on its own thread — so a rAF probe
can report "rows cover the viewport" for a frame that painted empty. The bridge's
`capture_native_screenshot` returns the real window surface in ~19 ms (fast
enough to catch a 5-frame event); decode with `pngjs` (already a dev dependency)
and score the region. Worked example + numbers:
`docs/perf/tab-switch-baseline.md`.

### Cleanup (this worktree only)

`driver_session` action `stop`, then:

```bash
if [ -f "$PID_FILE" ]; then
  CARGO_PID=$(cat "$PID_FILE")
  kill -- -$(ps -o pgid= "$CARGO_PID" | tr -d ' ') 2>/dev/null
  rm -f "$PID_FILE" "$TAURI_LOG"
fi
```

The PID file is the point: it is the identity of the stack YOU started. Never
clean up by process name. `pkill -f vite`, `pkill -f "cargo tauri dev"` and
friends are machine-wide — on 2026-08-19 they took out three peer worktrees,
silently: an orphaned app keeps its bridge port and stops rebuilding (the peer
reads that as "my change had no effect"), and a dead dev server returns an error
overlay instead of a test failure (M25). If the PID file is gone,
`node scripts/qa-target.mjs list` then `kill` reaches this worktree's app
instances only, and `just ports` prints the ports you own.

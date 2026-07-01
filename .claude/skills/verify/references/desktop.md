# Desktop — web fast path and the Tauri app

Two ways to see a change running on desktop. The web dev server is faster but
stubs out every Tauri command; the Tauri app is the real thing. When in doubt,
use Tauri. Both need the Instance Setup variables from SKILL.md (`$SLOT`,
`$VITE_PORT`, `$WEB_VITE_PORT`, `$TAURI_LOG`, `$PID_FILE`) — re-compute them
in every Bash block.

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
(`driver_session`, `webview_*`). The bridge picks a free port in 9223–9322 so
multiple worktree instances coexist.

### Launch (or reuse a running instance)

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
  cd "$WORKTREE_ROOT/apps/tauri" && \
    WINIT_UNIX_BACKEND=wayland GDK_BACKEND=wayland WEBKIT_DISABLE_DMABUF_RENDERER=1 \
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

# Fallback — find the listener by process (Linux: ss; macOS: lsof):
if [ -z "$MCP_PORT" ]; then
  TAURI_PID=$(pgrep -f "futo-notes-tauri" | tail -1)
  MCP_PORT=$(lsof -nP -a -p "$TAURI_PID" -iTCP -sTCP:LISTEN 2>/dev/null \
    | sed -n 's/.*:\(92[2-9][0-9]\|93[0-1][0-9]\|932[0-2]\) (LISTEN).*/\1/p' | head -1)
fi
echo "Using MCP bridge port: $MCP_PORT"
```

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
/ `.status()` / `.syncNow()` / `.disconnect()` — prefer these over UI
automation when switching sync servers (see AGENTS.md "Browser Tools").

### Cleanup (this worktree only)

`driver_session` action `stop`, then:

```bash
if [ -f "$PID_FILE" ]; then
  CARGO_PID=$(cat "$PID_FILE")
  kill -- -$(ps -o pgid= "$CARGO_PID" | tr -d ' ') 2>/dev/null
  rm -f "$PID_FILE" "$TAURI_LOG"
fi
```

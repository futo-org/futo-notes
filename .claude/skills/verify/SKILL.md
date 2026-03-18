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
| `apps/server/**` (not Dockerfile/docker-compose) | server |
| `apps/server/Dockerfile`, `docker-compose*` | server-docker |
| `apps/server/src/routes/dashboard*` | dashboard |
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
npx tsc --noEmit 2>&1 | head -30
```
If type errors → stop and report.

### frontend, styles, or unit-testable logic:
Build once (don't repeat if multiple categories match):
```bash
npm run build 2>&1 | tail -20
```

### frontend or styles — Playwright specs:
Find relevant specs by grepping for keywords related to the change:
```bash
grep -rl '<feature-keyword>' tests/*.spec.ts
```
Run matching specs, or if unsure run all:
```bash
npm run test 2>&1 | tail -40
```

### server:
```bash
npm run server:test 2>&1 | tail -30
```

### server-docker:
After server tests pass:
```bash
cd apps/server && docker compose up --build -d 2>&1 | tail -20
sleep 3 && curl -sf http://localhost:3005/health && echo "OK" || echo "FAIL"
docker compose down 2>&1
```

### dashboard:
After server tests pass, smoke-test the dashboard. Start a temp server (`cd apps/server && PORT=3005 NODE_ENV=development npx tsx src/index.ts &`), run the auth flow via curl (nuke → setup → login → authenticated endpoint → verify unauthenticated 401), then `pkill -f "tsx src/index.ts"`. If Playwright MCP browser tools are available, prefer using them to navigate to `http://localhost:3005/` and exercise the UI interactively — this catches rendering bugs that curl cannot.

### shared:
```bash
npm run test:shared 2>&1 | tail -20
```

### unit-tests or other unit-testable logic:
```bash
npm run test:unit 2>&1 | tail -30
```

### tauri-rust:
```bash
npm run tauri:test:rust 2>&1 | tail -30
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

When changes affect anything user-facing, or when verifying a user-facing feature, visually verify in the actual app. Skip for backend-only, test-only, or CI-only changes.

```bash
mkdir -p ./test-screenshots
```

### Choosing web vs Tauri

The web dev server (port 5173) stubs out all Tauri commands — it cannot exercise any code path that flows through Rust `#[tauri::command]` handlers, native file system operations, `@tauri-apps/*` plugin APIs, or platform-specific behavior. Many frontend files in this codebase depend on Tauri APIs (`invoke()`, `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-clipboard-manager`, etc.).

**Use the Tauri desktop app (port 5180) when ANY of these are true:**
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

**Use the web dev server (port 5173) ONLY when:**
- Changes are purely CSS / Tailwind styling
- Changes are purely CodeMirror decorations / markdown rendering (no Tauri API calls)
- No Rust changes involved
- The feature works identically with platform stubs

### Desktop (Web — CSS/markdown-only fast path)

Uses `agent-browser` (Rust CLI) — faster than Playwright MCP, handles CodeMirror typing natively, and supports annotated screenshots with element labels.

1. Start the dev server, then open in agent-browser:
```bash
npm run dev &
sleep 4
agent-browser open http://localhost:5173
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
pkill -f "vite" 2>/dev/null
```

### Desktop (Tauri — the default for most features)

This is the real app. Use it whenever the feature touches platform APIs, Rust commands, or anything beyond pure CSS/markdown rendering. The app has `tauri-plugin-mcp-bridge` installed (debug builds only), which exposes the Tauri MCP tools for direct webview interaction.

1. Kill any stale Tauri processes, then launch fresh:
```bash
pkill -f "futo-notes-tauri" 2>/dev/null
pkill -f "cargo-tauri" 2>/dev/null
sleep 2
npm run tauri:dev &
# Tauri compiles Rust + starts Vite on port 5180; first build is slow (~60s), rebuilds are faster (~20s)
```
Wait for the MCP bridge to be ready (port 9223):
```bash
for i in $(seq 1 90); do ss -tlnp 2>/dev/null | grep -q 9223 && echo "MCP bridge ready" && break; sleep 2; done
```

2. Connect via Tauri MCP tools:
   - `driver_session` with action `start` to connect to the running app
   - `webview_dom_snapshot` (type: accessibility) to see the current UI state with element refs
   - `webview_interact` to click, scroll, swipe elements (by CSS selector, text, or ref ID)
   - `webview_keyboard` to type text or press keys (for CodeMirror, use `webview_execute_js` with `document.execCommand('insertText', false, 'text')` since CM6 in WebKit doesn't respond to synthetic key events)
   - `webview_screenshot` to capture screenshots — use `filePath` to save to `./test-screenshots/desktop-<description>.png`
   - `webview_execute_js` to run JavaScript in the real app context (has access to `window.__TAURI__`)
   - `webview_find_element` to locate elements by CSS, XPath, or text

   Note: Native Tauri dialogs (`@tauri-apps/plugin-dialog`) are NOT in the DOM. Use coordinate-based `webview_interact` clicks based on screenshot positions to interact with them.

3. Clean up:
   - `driver_session` with action `stop`
   - Then kill processes:
```bash
pkill -f "cargo-tauri" 2>/dev/null
pkill -f "futo-notes-tauri" 2>/dev/null
```

### Android

Use when verifying Android-specific behavior or when the user asks. Requires a connected device or emulator. The app includes `tauri-plugin-mcp-bridge` (debug builds), so the same Tauri MCP tools used for desktop work on Android — no coordinate guessing or raw `adb` taps needed.

1. Check device is connected:
```bash
adb devices | grep -v "^List"
```

2. Build and deploy:
```bash
npm run build 2>&1 | tail -5
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
# Kill any stale desktop Tauri process that might hold port 9223
pkill -f "futo-notes-tauri" 2>/dev/null; sleep 1
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
- If the MCP bridge port (9223) is blocked by a stale desktop Tauri process, kill it first with `pkill -f "futo-notes-tauri"`.
- For video recording (e.g., animation verification), use `adb shell screenrecord` — the MCP tools don't support video capture.

### What to look for

Focus on what changed or the specific feature being verified. Common checks:
- **Editor**: Open a note, type text, verify decorations/widgets render correctly
- **Theme/styles**: Toggle light/dark, check contrast, verify no broken layouts
- **Navigation**: Sidebar, note switching, back/forward, search
- **Settings**: Open settings, toggle options, verify they persist after reload
- **New features**: Exercise the happy path, then try one edge case

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

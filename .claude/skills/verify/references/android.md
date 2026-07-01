# Android — native Compose app on the emulator

The shipping Android app is the native Jetpack Compose shell in `apps/android`
(Rust core via `futo-notes-ffi`, editor embedded as a WebView). There is no
Tauri Android shell and no MCP bridge on Android — you drive the native UI via
`adb` + uiautomator, and the editor WebView via CDP (`scripts/cdp-invoke.mjs`).

Debug builds install as `com.futo.notes.dev` ("FUTO Notes Dev"); the vault is
app-private at `files/futo-notes` inside the app's data dir. Isolation from a
production install comes from the `.dev` application-id suffix.

## 1. Device or emulator

```bash
adb devices                 # anything attached?
just emu-boot               # if not: boots the first available AVD and waits for it
```

With **multiple** devices attached (e.g. two emulators), every `adb` call
needs a target — export it once instead of adding `-s` everywhere:

```bash
export ANDROID_SERIAL=emulator-5554
```

## 2. Build, install, launch

```bash
just android-native         # full chain: Rust ffi (all ABIs) → editor bundle → gradle installDebug → launch
```

For app-only iteration (no Rust/editor changes), skip the Rust rebuild:

```bash
cd apps/android && ./gradlew :app:installDebug
adb shell am force-stop com.futo.notes.dev
adb shell monkey -p com.futo.notes.dev -c android.intent.category.LAUNCHER 1
adb shell pidof com.futo.notes.dev    # confirm it's running
```

- `INSTALL_FAILED_INSUFFICIENT_STORAGE` → uninstall stale builds:
  `adb shell pm uninstall com.futo.notes.dev` (and any old `com.futo.notes`
  debug variants).
- The Rust/Kotlin bindings are generated and gitignored — a fresh checkout
  must run `just android-native` (or `just build-rust-android`) once before
  any bare `gradlew` invocation will compile.
- First Gradle run is slow (~2–3 min); warm rebuilds are fast.

## 3. Drive the native UI

Compose UI is driven with coordinate taps — but read coordinates from the
**uiautomator dump**, not from screenshot guesswork:

```bash
adb shell uiautomator dump /sdcard/ui.xml >/dev/null && adb pull /sdcard/ui.xml /tmp/ui.xml
grep -o '[^>]*grocery[^>]*' /tmp/ui.xml     # find node; its bounds="[l,t][r,b]" give tap coords
```

```bash
adb shell input tap 959 2216                 # tap (FAB, buttons, rows)
adb shell input swipe 850 1459 150 1459 300  # swipe row left → reveal actions
adb shell input swipe 540 1800 540 600 300   # scroll
adb shell input text 'grocery%slist'         # type into focused field (%s = space)
adb shell input keyevent 4                   # Back (also drops the keyboard)
adb shell input keyevent 67                  # Backspace
```

Long-press = `input swipe X Y X Y 700` (same point, 700ms). After each
action, re-dump before the next read — the tree goes stale. Check long-press
context menus and swipe actions before declaring an affordance missing
(`docs/spec/AGENTS.md`).

Screenshots:

```bash
just emu-screenshot android-dark-list   # → ./test-screenshots/android-dark-list.png
```

**Don't** use `input tap` on coordinates *inside the editor WebView* — device
pixel ratio and viewport offsets make them unreliable. Use CDP for anything
inside the editor.

## 4. Drive the editor WebView via CDP

Debug builds enable WebView debugging (`EditorWebView.kt`). One-time setup per
app launch, then evaluate arbitrary JS in the editor page:

```bash
just cdp-forward            # finds the app's devtools socket, forwards to :9228
node scripts/cdp-invoke.mjs "document.title"
node scripts/cdp-invoke.mjs "window.FutoEditor.getContent()"
node scripts/cdp-invoke.mjs "window.FutoEditor.setContent('# from CDP')"
```

`window.FutoEditor` is the embed's API surface (setContent / getContent /
focus / setTheme / exec / setNativeToolbar, …) — see the contract comment at
the top of `apps/ios/Sources/EditorWebView.swift` (same embed on both
platforms). There is **no** `window.__TAURI__` or `window.__testSync` here —
those are Tauri-desktop-only. `cdp-invoke.mjs` awaits promises and bypasses
page CSP; re-run `just cdp-forward` after an app restart (the WebView pid
changes).

## 5. Logs

The app logs under stable tags — scope logcat to them instead of grepping the
firehose:

```bash
adb logcat -c               # clear first, act, then read:
just emu-logs               # = adb logcat -s FutoStartup FutoSearch NotesStore FutoToolbarDBG FutoBridgeDBG AndroidRuntime
```

`AndroidRuntime` catches crashes; `FutoBridgeDBG`/`FutoToolbarDBG` log the
editor↔native bridge. Crash reports land in `<vault>/.crashlogs` and are
offered for upload on the next launch.

## 6. App data: seeding and verification

The vault is app-private, but debug builds are debuggable — `run-as` works:

```bash
adb shell run-as com.futo.notes.dev ls files/futo-notes
adb shell run-as com.futo.notes.dev cat 'files/futo-notes/grocery list.md'

# Seed a fixture, then relaunch so the scan picks it up:
printf '# Seeded\n' | adb shell run-as com.futo.notes.dev sh -c 'cat > "files/futo-notes/Seeded Note.md"'
adb shell am force-stop com.futo.notes.dev
adb shell monkey -p com.futo.notes.dev -c android.intent.category.LAUNCHER 1
```

Full reset: `adb shell pm clear com.futo.notes.dev` (wipes vault + prefs +
sync state).

Like iOS, backgrounding the app (`adb shell input keyevent 3` = HOME) flushes
pending editor edits to disk — background, then read the file to verify editor
content.

## 7. Sync features

The emulator cannot reach the host's `127.0.0.1` — use **`10.0.2.2`** for any
host-side service (sync server URL in Settings, etc.). Native shells have no
`__testSync` hook — connect through Settings → Sync in the app UI. Server
setup: see "Features that need a sync server" in SKILL.md.

## Known gotchas

- **IME/keyboard**: keyboard-specific WebView crashes have history here — the
  retired Tauri shell needed a shadow-InputConnection workaround
  (`docs/learnings/ime-shield-workaround.md`, kept as prior art). If a
  keyboard-triggered renderer crash appears in the native shell, read that
  doc before debugging from scratch. IME/status-bar issues generally need
  device/emulator QA — Playwright can't see them.
- Some Compose surfaces (dialogs, menus) render in separate windows; if a
  node is missing from the uiautomator dump, re-dump after a short sleep.
- `adb shell input text` can't type into the editor WebView reliably — focus
  it first via tap, or use CDP `setContent`/`exec` for content-level work.

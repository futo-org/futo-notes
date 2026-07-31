# Android — native Compose app on the emulator

The shipping Android app is the native Jetpack Compose shell in `apps/android`
(Rust core via `futo-notes-ffi`, editor embedded as a WebView). There is no
Tauri Android shell and no MCP bridge on Android. Three ways in, cheapest first:

| Layer | Tool | Cost |
| --- | --- | --- |
| App state + named actions | `just android-drive state` / `hook` | ~0.2s |
| Native Compose UI | `just android-drive tree` / `tap` (uiautomator) | ~2s per read |
| Inside the editor WebView | `scripts/cdp-invoke.mjs` (CDP) | ~0.1s |

**Reach for the state hook before the accessibility tree.** An a11y dump costs
~2s and shows you what Compose last managed to render — an unfocused emulator
throttles frames, so it can be stale (M21). `state` answers from the app itself
and reports things the tree cannot show at all: which vault is live, how many
notes the store holds, whether a migration is in flight. Use the a11y tree when
the UI *is* what you're verifying.

Debug builds install as `com.futo.notes.dev` ("FUTO Notes Dev"); the vault is
app-private at `files/futo-notes` inside the app's data dir. Isolation from a
production install comes from the `.dev` application-id suffix.

## 1. Device or emulator

```bash
just qa-claim android       # THE way in a shared/parallel session: claims this
                            # worktree's pooled AVD, boots it, prints
                            # `export ANDROID_SERIAL=<serial>` — set it in every Bash block
adb devices                 # solo alternative: anything already attached?
just emu-boot               # boots the first available AVD if nothing is
```

`adb` honors `$ANDROID_SERIAL` natively; with multiple devices attached every
`adb` call is ambiguous without it. Driving a device another session claimed
(see `just qa-status`) causes install-thrashing — don't. Release with
`just qa-release` when done.

## 2. Build, install, launch

```bash
just android-native         # full chain: Rust ffi (all ABIs) → editor bundle → gradle installDebug → launch
```

For app-only iteration (no Rust/editor changes), skip the Rust rebuild:

```bash
cd apps/android && ./gradlew :app:installDebug
adb shell am force-stop com.futo.notes.dev
adb shell am start -n com.futo.notes.dev/com.futo.notes.MainActivity
adb shell pidof com.futo.notes.dev    # confirm it's running
```

(`am start -n` is the reliable launcher — `adb shell monkey -p … 1` exits 251
without launching on some emulators. If the activity name ever moves:
`adb shell cmd package resolve-activity --brief com.futo.notes.dev`.)

**First run on a fresh AVD hits onboarding**: a "Where should your notes
live?" storage choice plus an "All files access" permission grant stand
between launch and the note list. On small AVD resolutions the
Continue/Grant buttons sit below the fold — scroll before concluding
they're missing.

- `INSTALL_FAILED_INSUFFICIENT_STORAGE` → uninstall stale builds:
  `adb shell pm uninstall com.futo.notes.dev` (and any old `com.futo.notes`
  debug variants).
- The Rust/Kotlin bindings are generated and gitignored — a fresh checkout
  must run `just android-native` (or `just build-rust-android`) once before
  any bare `gradlew` invocation will compile.
- First Gradle run is slow (~2–3 min); warm rebuilds are fast.

## 3. Drive the app

`just android-drive` (= `node scripts/android-drive.mjs`) is the front door. Run
it with no arguments for the command list. It honors `$ANDROID_SERIAL`, so
`just qa-claim android` is the only setup.

```bash
just android-drive state                    # app state as JSON — fast, and not a UI read
just android-drive tree                     # labelled tap targets: "  114,121   Groceries"
just android-drive tap 'Settings'           # find by label (scrolling if needed), tap once
just android-drive wait shellVisible=true storageMode=DEVICE
just android-drive hook storage-mode mode=DEVICE
just android-drive logs                     # the app's tagged logs
just android-drive shot android-dark-list   # → ./test-screenshots/android-dark-list.png
just android-drive relaunch                 # restart and wait until it answers again
```

`tap` anchors on the node's own text or content-desc, so a layout change can't
silently hit the wrong control the way copied coordinates can. It taps **once**:
re-tapping until something changes reads as robustness, but a dialog that closes
between the look and the tap leaves the extra taps landing on whatever is
underneath — that is how a retry loop once reached the Settings Danger zone.

### Named hooks (debug builds only)

The debug build registers a broadcast-driven command surface — Android's
counterpart of the desktop `window.__testSync` hook, for the same reason. Hooks
call the app's own entry points, so what they replace is the tapping, not the
code under test.

```bash
just android-drive hook state              # every field of the state snapshot
just android-drive hook storage-mode mode=DEVICE
just android-drive hook confirm-storage
just android-drive hook nonesuch           # errors listing the hooks that DO exist
```

Every call waits for the app's own ack, so a broadcast that reached nothing fails
at the call — `am broadcast` alone reports success either way. Adding a hook is a
few lines in `MainActivity.testHooks()`; see `apps/android/AGENTS.md`.

### Raw adb, when you need a gesture the driver doesn't expose

```bash
adb shell input swipe 850 1459 150 1459 300  # swipe row left → reveal actions
adb shell input swipe X Y X Y 700            # long-press (same point, 700ms)
adb shell input text 'grocery%slist'         # type into focused field (%s = space)
adb shell input keyevent 4                   # Back (also drops the keyboard)
adb shell input keyevent 67                  # Backspace
```

After any action the a11y tree is stale — re-read before the next lookup (the
driver invalidates its cache for you). Check long-press context menus and swipe
actions before declaring an affordance missing (`docs/spec/AGENTS.md`).

**Don't** use `input tap` on coordinates *inside the editor WebView* — device
pixel ratio and viewport offsets make them unreliable. Use CDP for anything
inside the editor.

### Writing a harness instead of a one-off

`tests/lib/android/` is the library behind the CLI: `createAndroidDevice()` gives
you `state`/`waitForState`/`callHook`/`tap`/`waitForLabel`/`shellBatch` plus
`waitFor`, whose timeout messages report what the app looked like when time ran
out. `tests/android-storage-migration.mjs` is the worked example — six
user-level stories, hook-driven except where the UI itself is under test.
Prefer it over ad-hoc `adb` pipelines pasted into a shell block.

## 4. Drive the editor WebView via CDP

Debug builds enable WebView debugging (`EditorWebView.kt`). One-time setup per
app launch, then evaluate arbitrary JS in the editor page:

```bash
just cdp-forward            # finds the app's devtools socket, forwards to a
                            # per-worktree port, prints `export CDP_PORT=…` — set it
node scripts/cdp-invoke.mjs "document.title"
node scripts/cdp-invoke.mjs "window.FutoEditor.getContent()"
node scripts/cdp-invoke.mjs "window.FutoEditor.setContent('# from CDP')"
```

`window.FutoEditor` is the embed's API surface (setContent / getContent /
focus / setTheme / exec / setNativeToolbar, …) — see the contract comment at
the top of `packages/editor/src/bridge.ts` (same embed on both
platforms). **`setContent` updates the visible editor only** — it does not
fire the native change/save pipeline, so the content reverts on background
unless you also post the bridge message a real keystroke would send:
`window.futoBridge.postMessage(JSON.stringify({type:'change', content}))`
(or send one real keystroke through the UI). There is **no** `window.__TAURI__` or `window.__testSync`
inside this page — those are Tauri-desktop-only; the Android equivalent is the
native hook surface in §3, driven by broadcast rather than JS.
`cdp-invoke.mjs` awaits promises and bypasses page CSP; re-run
`just cdp-forward` after an app restart (the WebView pid changes).

## 5. Logs

The app logs under stable tags — scope logcat to them instead of grepping the
firehose:

```bash
just android-drive logs     # the same tags, without needing to remember them
adb logcat -c               # clear first, act, then read:
just emu-logs               # = adb logcat -s FutoStartup FutoSearch NotesStore FutoTestHook FutoToolbarDBG FutoBridgeDBG AndroidRuntime
```

`AndroidRuntime` catches crashes; `FutoBridgeDBG`/`FutoToolbarDBG` log the
editor↔native bridge; `FutoTestHook` carries one ack line per hook call. Crash
reports land in `<vault>/.crashlogs` and are offered for upload on the next
launch.

Prefer clearing the log only when you must: tokens make hook acks
self-identifying, so nothing here needs a `logcat -c` first, and clearing is a
device-wide side effect that races anything else watching.

## 6. App data: seeding and verification

The vault location depends on the onboarding storage choice — don't guess which
one is live, ask: `just android-drive state` reports `vaultPath` and `notes`.

- **Device storage** (the recommended option): shared storage at
  `/storage/emulated/0/Documents/FUTO Notes Dev` — plain `adb shell
  cat`/`find` works; `run-as` does NOT (that path 404s under it).
- **App storage**: app-private `files/futo-notes` — debug builds are
  debuggable, so `run-as com.futo.notes.dev` works there.

Note `run-as … ls files` hides the storage-migration journal, which is a dotfile
(`files/.storage-migration`); use `ls -a` when a storage switch misbehaves — the
journal outranks the stored preference at startup.

```bash
adb shell find '/storage/emulated/0/Documents/FUTO Notes Dev' -name '*.md'   # device storage
adb shell run-as com.futo.notes.dev ls files/futo-notes                      # app storage

# Seed a fixture (device-storage vault), then relaunch so the scan picks it up:
printf '# Seeded\n' | adb shell sh -c 'cat > "/storage/emulated/0/Documents/FUTO Notes Dev/Seeded Note.md"'
adb shell am force-stop com.futo.notes.dev
adb shell am start -n com.futo.notes.dev/com.futo.notes.MainActivity
```

Full reset: `adb shell pm clear com.futo.notes.dev` (wipes vault + prefs +
sync state).

Like iOS, backgrounding the app (`adb shell input keyevent 3` = HOME) flushes
pending editor edits to disk — background, then read the file to verify editor
content.

## 7. Sync features

The emulator cannot reach the host's `127.0.0.1` — use **`10.0.2.2`** for any
host-side service (sync server URL in Settings, etc.). There is no sync hook yet,
so connect through Settings → Sync in the app UI; if you find yourself tapping
that flow repeatedly, add one to `MainActivity.testHooks()` instead. Server
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

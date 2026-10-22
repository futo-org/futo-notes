# Android — native Compose app on the emulator

The shipping Android app is the native Jetpack Compose shell in `apps/android`
(Rust core via `futo-notes-ffi`, editor embedded as a WebView). There is no
Tauri Android shell and no MCP bridge on Android.

> **Use the `puppet` skill (`.claude/skills/puppet/`) — it is the only sanctioned
> way to drive this app.**
> Notes, folders, navigation and every editor action are verbs
> (`FUTO_PUPPET_TARGET=android just puppet actions`) that run through the app's own
> handlers and answer with a diff, and `tap`/`drag` land a real `adb shell input`
> touch at the dp point `elements` reports, on this worktree's claimed emulator: the
> CLI claims one on first use and opens its own `adb forward`. The rest of this file
> is for what verbs do not cover: the toolchain, building and launching, what nothing
> reaches (§3), the app's own state hook, and disk verification.

Debug builds install as `com.futo.notes.dev` ("FUTO Notes Dev"); the vault is
app-private at `files/futo-notes` inside the app's data dir. Isolation from a
production install comes from the `.dev` application-id suffix.

## 1. Device or emulator

```bash
just qa-claim android       # THE way in a shared/parallel session: claims this
                            # worktree's pooled AVD, boots it, prints
                            # `export ANDROID_SERIAL=<serial>` — set it in every Bash block
adb devices                 # solo alternative: anything already attached?
```

For a pinned legacy-WebView fixture, claim its exact name instead:

```bash
just qa-claim android --avd futo-api28   # also futo-api29 / futo-api30
```

The named AVD must already exist. This registers ownership, boots it if needed,
and includes it in `just qa-status`; it preserves its pinned config, WebView and
app data. `just qa-release android` releases all Android claims this worktree
holds. `just qa-gc` releases stale legacy claims without deleting those fixtures.

Pooled AVDs pin `show_ime_with_hard_keyboard=1` on each claim. If host-keyboard
input turned it off, the claim sets it and gracefully reboots Android on that
owned emulator once, then verifies the setting survived. `just qa-claim android --reboot` explicitly
reboots Android on the selected owned emulator. Named legacy fixtures keep their
existing keyboard setup. If host-keyboard input changes this setting after a claim,
re-run `just qa-claim android` (or add `--reboot`) before instrumentation QA.

`qa-claim` also exports `ANDROID_AVD_NAME`. Keep both exports: emulator serial
ports can be reused by another AVD after a shutdown. `just qa-android-target`
checks the live AVD name and its worktree owner; the native install recipe and
`android-drive` check it automatically. Re-run the claim when it refuses a stale
serial. Direct `adb` and Gradle calls bypass that guard, so run
`just qa-android-target` immediately before using those tools.

`adb` honors `$ANDROID_SERIAL` natively; with multiple devices attached every
`adb` call is ambiguous without it. `just puppet` needs no export: it reads the
claim itself. Driving a device another session claimed (see `just qa-status`)
causes install-thrashing — don't. Release with
`just qa-release android` when done — a bare `just qa-release` also frees any
simulator this worktree claimed.

## 2. Build, install, launch

```bash
just android-native         # full chain: Rust ffi (device ABI) → editor bundle → gradle installDirectDebug → launch
```

Before QA, run `just qa-android-apk` to compare the installed APK SHA-256 with
this worktree's built debug APK. `android-drive` and the native story helpers
perform this check at readiness; `android-native` checks immediately after
installing. Set `FUTO_ANDROID_FLAVOR=play` for a Play-flavor debug build, or pass
an explicit APK path to `just qa-android-apk <path>`. A mismatch means the
installed build changed; rebuild/reinstall before interpreting screenshots or
plugin behavior as this branch's result.

For app-only iteration (no Rust/editor changes), skip the Rust rebuild. The APK
carries only the ABI the last Rust build targeted (none if it failed or was
stopped), so after switching to a device of another ABI, rerun
`just android-native` first:

```bash
cd apps/android && ./gradlew :app:installDirectDebug
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
  must run `just android-native` (or `just build-rust-android device`) once before
  any bare `gradlew` invocation will compile.
- First Gradle run is slow (~2–3 min); warm rebuilds are fast.

## 3. Native Compose chrome — what nothing reaches

**Everything the app itself owns — notes, folders, navigation, the editor and its title
field, find bar and ⋯ menu, Search, Settings, Storage location and its dialog that opens an
already-populated folder, Sync, Feedback and the crash dialog — is a verb: use the `puppet`
skill** (`state.screen` names every screen; `actions` lists what each offers). Check a row's
long-press menu and swipe actions before declaring an affordance missing
(`docs/spec/AGENTS.md`).

Outside the app — the share chooser `ShareRecoveryKey` opens, the system's permission and
settings screens — `elements` sees nothing: `just puppet screenshot` shows it, and
`press {"key":"Back"}`, the system's Back, closes it as it does for a person.

`just android-drive state` (`scripts/android-drive.mjs`) answers what `just puppet state`
does not: which vault is live, how many notes the store holds, whether a migration is in
flight. It honors `$ANDROID_SERIAL`, so `just qa-claim android` is the only setup.

```bash
just android-drive state                    # app state as JSON — fast, and not a UI read
just android-drive wait shellVisible=true storageMode=DEVICE
just android-drive logs                     # the app's tagged logs
```

### Named hooks (debug builds only)

The debug build registers a broadcast-driven command surface for harnesses —
Android's counterpart of the desktop `window.__testSync` hook. Hooks call the app's
own entry points, so what they replace is the tapping, not the code under test.

```bash
just android-drive hook state              # every field of the state snapshot
just android-drive hook nonesuch           # errors listing the hooks that DO exist
```

Every call waits for the app's own ack, so a broadcast that reached nothing fails
at the call — `am broadcast` alone reports success either way. Adding a hook is a
few lines in `MainActivity.testHooks()` (`MainActivityTestHooks.kt`); see `apps/android/AGENTS.md`.

### Writing a harness instead of a one-off

`tests/lib/android/` is the library behind the CLI: `createAndroidDevice()` gives
you `state`/`waitForState`/`callHook`/`tap`/`waitForLabel`/`shellBatch` plus
`waitFor`, whose timeout messages report what the app looked like when time ran
out. `tests/android-storage-migration.mjs` is the worked example — six
user-level stories, hook-driven except where the UI itself is under test.
Prefer it over ad-hoc `adb` pipelines pasted into a shell block.

An engine-ready state does not put every `LazyColumn` row in the viewport.
Use the label driver's scrolling tap for seeded root notes; `openEditorPage`
does this without changing the persisted sort order.

Back follows the device navigation mode: `back`, `key back`, `key 4`, and
`key KEYCODE_BACK` use a left-edge gesture on gesture-navigation devices and a
Back key on button-navigation devices. Unknown modes fail with a diagnostic.
`text` appends by default; use `text --replace` to select all, clear, and enter a
new native-field value. A missing tap label fails the command.

## 4. Drive the editor WebView via CDP

Debug builds enable WebView debugging (`EditorWebView.kt`). One-time setup per
app launch, then evaluate arbitrary JS in the editor page:

```bash
just cdp-forward            # finds the app's devtools socket, forwards to a
                            # per-worktree port, prints `export CDP_PORT=…` — set it
node scripts/cdp-invoke.mjs "document.title"
node scripts/cdp-invoke.mjs "window.__futoTest.readDocument()"
node scripts/cdp-invoke.mjs "window.FutoEditor.setContent('qa-note', '# from CDP')"
```

`window.FutoEditor` is the embed's API surface (setContent / flush /
focus / setTheme / exec / setNativeToolbar, …) — see the contract comment at
the top of `packages/editor/src/bridge.ts` (same embed on both
platforms). **`setContent` updates the visible editor only** — it does not
fire the native change/save pipeline. Make a reportable ProseMirror edit or send
one real keystroke through the UI, then request `FutoEditor.flush('qa')`. Production
hosts receive tagged messages; never manufacture an anonymous `change`. Debug
builds expose `__futoTest.readDocument()` for assertions only.
There is **no** `window.__TAURI__` or `window.__testSync`
inside this page — those are Tauri-desktop-only; the Android equivalent is the
native hook surface in §3, driven by broadcast rather than JS.
`cdp-invoke.mjs` awaits promises and bypasses page CSP; re-run
`just cdp-forward` after an app restart (the WebView pid changes).

For an editor typing story, a `just puppet type` that answered OK into a focused
WebView does not prove the whole string arrived: its keys go through adb, which can
deliver a prefix or nothing. Check the receipt's `doc` line and the saved note. A CDP
harness can use the
existing `connectPage` client (`tests/lib/editorDevicePerfSnippets.mjs`): focus
the editor, send `cdp.send('Input.insertText', { text })`, then assert the exact
document change and persistence. This drives the editor's input path; it does
not verify a physical keyboard or the real IME's composition behavior.

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

### Package Manager stalls during an install

`pm list packages` and `pm path` can block while an APK install is in progress,
even while adb transport is responsive. Use
`just qa-android-package --installed com.futo.notes.dev` with the claimed target
exports: it bounds the PM command at five seconds, then bounds a separate
`get-state` diagnostic at two seconds. `get-state=device` means the transport
answered and Package Manager may be busy; wait for your owned install to finish
before retrying. An offline state or transport timeout identifies a connection
problem instead. Only a completed successful query can report package absence;
timeouts and PM errors fail with their diagnostic. The same probe backs the
device drivers and CI readiness checks; APK installs keep their own lifecycle.

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
adb shell 'stat -c "%y %n" /data/local/tmp'                                 # Toybox mtime syntax

# Seed a fixture (device-storage vault), then relaunch so the scan picks it up:
printf '# Seeded\n' | adb shell sh -c 'cat > "/storage/emulated/0/Documents/FUTO Notes Dev/Seeded Note.md"'
FUTO_PUPPET_TARGET=android just puppet relaunch
```

Full reset: `adb shell pm clear com.futo.notes.dev` (wipes the APP/INTERNAL
vault, prefs and sync state) plus `adb shell rm -rf "'/storage/emulated/0/Documents/FUTO Notes Dev'"`
for a DEVICE-mode vault, which lives outside the package. `just qa-claim` does
both when it hands you a pool emulator another worktree used.

To verify editor content on disk, wait until `just puppet state`'s `pending.unsaved`
is empty (the edits are written), then read the file.

Android's Toybox `stat`/`ls` do not support GNU `--time-style=full-iso`.
Use `stat -c '%y %n' <path>` for timestamps; add `run-as com.futo.notes.dev`
before `stat` for app-private files.

### Recordings and tap markers

`show_touches=1` can display a pointer on the emulator while `adb screenrecord`
omits it from the recording. Inspect the actual movie before treating that
setting as recorded evidence. If markers are needed, retain the driven tap
coordinates and timestamps and overlay them during video processing; identify
those markers as annotations. Confirm each action through its rendered or
saved result, since an annotated tap does not prove delivery.

## 7. Sync features

The emulator cannot reach the host's `127.0.0.1` — use **`10.0.2.2`** for any
host-side service (sync server URL in Settings, etc.). Connect with the sync verbs
(`OpenSync`, `ToggleOwnServer`, `ConnectSync`). Server setup: see "Features that need
a sync server" in SKILL.md.

## Camera poster for QR stories

Save and close the current QA app first: this command restarts its claimed
emulator. It preserves AVD config and app data, validates the PNG and SDK macro
before stopping anything, and enables the virtual-scene back camera with the
image on both wall and table posters.

```bash
eval "$(just emu-camera-poster /absolute/path/to/qr.png)"
```

Keep the refreshed serial/name exports, then open the scanner. The helper plays
the SDK's `Walk_to_image_room` macro; wait for an actual preview rather than a
camera splash screen before judging the QR image. A fresh system Camera app may
show onboarding first. PNGs must decode and fit within 4096 by 4096 pixels.

To swap a QR code, overwrite the same PNG path and close/reopen the app's camera
session. The emulator rereads the poster on a new camera session, not when the
file changes. A different poster path requires running the helper again.

## Known gotchas

- **IME/keyboard**: keyboard-specific WebView crashes have history here — the
  retired Tauri shell needed a shadow-InputConnection workaround that was
  later removed once FUTO Keyboard fixed the crash upstream (see
  `docs/spec/editor.md`, "Backspace on an empty note"). IME/status-bar issues generally need
  device/emulator QA — Playwright can't see them.

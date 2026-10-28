# iOS — native SwiftUI app on the simulator

The shipping iOS app is the native SwiftUI shell in `apps/ios` (Rust core via
`futo-notes-ffi`, editor embedded as a WKWebView). There is no Tauri iOS shell
and no MCP bridge on iOS.

> **Use the `puppet` skill (`.claude/skills/puppet/`) — it is the only sanctioned
> way to drive this app.**
> Notes, folders, navigation and every editor action are verbs
> (`FUTO_PUPPET_TARGET=ios just puppet actions`) that run through the app's own
> handlers and answer with a diff, and every native screen (lists, sheets,
> dialogs) is `elements` plus real `tap`/`drag` there. The rest of this file is
> for what `just puppet` does not cover: the toolchain, building and launching,
> what nothing reaches (§3), and disk verification.

`just puppet tap`/`drag`/`type`/`press` land a **real finger** and real keys through
`axe` ([AXe](https://github.com/cameroncooke/AXe)) and trace what they did; the
filesystem is the oracle for what landed on disk (see "Reading what landed" below).

Debug builds install as `com.futo.notes.dev` ("FUTO Notes Dev") with notes at
`Documents/fake-notes` inside the app container — they can never touch the
production app or real notes.

## Recover a parked software keyboard

After `just qa-claim ios --reboot`, take a fresh tree and screenshot if keyboard rows remain
off-screen. The hardware-keyboard preference does not prove visibility; iOS 27 letter keys can
be Buttons. Check frames and rendered input rather than requiring one accessibility type.
For a claimed, disposable QA simulator:

```bash
just qa-claim ios --erase
just ios-native
```

**Erase removes every app, vault, preference and keychain item on that simulator.** Use only
state this task created, or obtain approval before discarding preexisting expensive/real data
(root `AGENTS.md` §11); ownership does not establish disposability.

Erase requires exactly one existing claim owned by this worktree, accepts no personal-device
override, and never acquires another device. It rechecks ownership and the original UDID before
shutdown/erase, waits for observed Shutdown, and refuses identity changes or ambiguous claims.
Normal claiming then boots the same device and disconnects its hardware keyboard. Failed retries
never erase automatically. Reinstall the dev app, confirm Done/letter-key frames are on-screen,
touch a visible key and observe the complete rendered/saved marker before resuming. Tap success
alone proves nothing; recovery discards simulator state without diagnosing an app defect or
proving the original corruption reproducible.

## Toolchain

macOS does not include GNU `timeout`. For bounded process calls in portable
Node tooling, use `execFileSync(command, args, { timeout: milliseconds })` or
`spawnSync`'s `timeout`; do not rely on an uninstalled shell command to bound a
simctl or AXe operation.

Everything below assumes: Xcode (with a downloaded simulator runtime),
`xcodegen` (brew), the Rust iOS targets (`aarch64-apple-ios-sim`), and `axe`.
`just ios-native` fails with a clear message when something is missing.

Installing `axe` — `brew install cameroncooke/axe/axe` is the documented path,
but it fails on this Mac with `Error: Failed to parse curl version from` (a
pre-existing broken Homebrew: shallow git repo, `brew config` reports
`Curl: N/A`). The tarball needs no install and bundles its own frameworks:

```bash
mkdir -p /tmp/axe && cd /tmp/axe
curl -sL -o axe.tar.gz https://github.com/cameroncooke/AXe/releases/download/v1.8.0/AXe-macOS-v1.8.0-universal.tar.gz
tar xzf axe.tar.gz && ./axe --version    # 1.8.0
export AXE_BIN=/tmp/axe/axe              # scripts/describe-ios-ui.mjs honors this
export PATH="/tmp/axe:$PATH"             # `just puppet` runs the axe on PATH
```

## 1. Get a simulator

```bash
just qa-claim ios                  # THE way in a shared/parallel session: claims
                                   # this worktree's pooled sim, boots it, prints
                                   # `export SIM=<udid>` — set it in every Bash block
just sim-boot                      # solo alternative: boots "iPhone 17 Pro"
just sim-udid                      # $SIM if set, else the single booted UDID
                                   # (errors when several sims are booted — claim instead)
```

All `sim-*` recipes and `apps/ios/run.sh` honor `$SIM`. With more than one
booted simulator, bare `booted` targeting is ambiguous — always pin `SIM`.
Release the claim with `just qa-release ios` when the session is done — a bare
`just qa-release` also frees any Android emulator this worktree claimed.

## 2. Build, install, launch

```bash
just ios-native          # full chain: Rust ffi → editor bundle → xcodegen → xcodebuild → install + launch
SIM=<udid> just ios-native   # target a specific simulator instead of "the booted one"
```

`apps/ios/run.sh` encodes two non-obvious constraints — don't bypass it with
raw `xcodebuild`:

- **Ad-hoc signing** (`CODE_SIGN_IDENTITY="-"` + entitlements): required for
  the simulator keychain. Unsigned builds fail keychain reads with
  `errSecMissingEntitlement (-34018)`, which breaks sync-password persistence.
- **Build order**: Rust xcframework → editor bundle → `xcodegen generate` →
  build. The Xcode project references generated artifacts.

If the build behaves strangely after config changes (`project.yml`,
Info.plist), clear the cache: `rm -rf apps/ios/.build`.

Relaunch after a state change (the note scan runs at launch) with
`FUTO_PUPPET_TARGET=ios just puppet relaunch`: a bare `simctl launch` starts the app
without its puppet listener, which needs `SIMCTL_CHILD_FUTO_PUPPET_PORT`.

## 3. Native chrome only — what the verbs cannot reach

[ios/native-chrome.md](ios/native-chrome.md): the menus iOS presents itself, hold-then-drag,
and what nothing reaches.

## 4. Screenshots, appearance, logs

```bash
just sim-screenshot ios-dark-list    # → ./test-screenshots/ios/s<SLOT>/<SIM>/ios-dark-list.png
just sim-appearance dark             # system dark mode (app + editor follow live)
just sim-appearance light
```

If a PNG exceeds an image reader's input limit, re-encode the owned capture as
JPEG; resizing the PNG alone can still leave it too large:

```bash
sips -s format jpeg -s formatOptions 80 "$CAPTURE_PNG" --out "$CAPTURE_JPEG"
```

Editor-story warmup and failure screenshots use the same worktree-slot and
simulator namespace: `test-screenshots/ios/s<SLOT>/<SIM>/`.

The app logs mostly via `print()`, which only reaches a console-attached
launch — `log stream` alone misses it:

```bash
xcrun simctl terminate "$SIM" com.futo.notes.dev 2>/dev/null
SIMCTL_CHILD_FUTO_PUPPET_PORT=$(node scripts/lib/slot.mjs puppet) \
  xcrun simctl launch --console-pty "$SIM" com.futo.notes.dev   # stdout incl. print() (blocks; use run_in_background)
xcrun simctl spawn "$SIM" log show --last 2m --debug --predicate 'process == "FutoNotesNative"'   # os_log/WebKit, bounded: exits
```

`log stream` never exits on its own, so a foreground call hangs a
non-interactive shell until it is interrupted. Use the bounded `log show --last`
above to read what already happened; when you need `log stream`, start it with
`run_in_background` and redirect it to a file.

## 5. App data and sync

For fixture seeding, saved-content verification and sync setup, read
[iOS app data and sync verification](ios-data-and-sync.md).

## Known gotchas

- **`axe`/`idb` report a 0x0 root** → this is a WINDOWING problem, not the app.
  A simulator booted without a Simulator.app window in the current WindowServer
  session returns a degenerate 0x0 root for every UI query, while
  `just sim-screenshot` keeps working perfectly the whole time — so it reads as
  "the app renders nothing" and can burn a whole session. Re-running
  `open -a Simulator` does NOT fix it: `-CurrentDeviceUDID` is only read when
  Simulator.app launches, so an already-running instance ignores it. The repair
  is a full device cycle: `just qa-claim ios --reboot`. Suspect this before the
  app whenever screenshots work but UI queries return nothing (M21).
- **Keyboard keys listed OFF-SCREEN below the screen, no software keyboard
  visible** → the simulator's boot-attached hardware keyboard is connected.
  Every boot re-attaches it and Xcode 27 has no Simulator.app to detach it;
  `just qa-claim ios` and the stories detach it after each boot
  (`scripts/lib/simulator-keyboard.mjs`). A device you rebooted yourself needs
  a re-claim. If a script injects HID text and keyboard visibility matters,
  re-read the keyboard key frames before continuing; HID typing can hide the
  software keyboard on some simulator states even when it reports success.
- **Taps report success but nothing happens, on every simulator** → check
  whether Xcode 27's DeviceHub is running. While it runs it takes the
  touchscreen of every booted simulator, and the device log shows
  `already have a main display digitizer` for each scripted tap. Quit it and
  reboot the simulator.
- **Locked physical iPhone** → `FBSOpenApplicationErrorDomain error 7` on
  launch; unlock and relaunch (device installs: `just ios-native-device`).
- **Theme**: the app pushes theme changes into the editor live
  (`FutoEditor.setTheme` on trait change). If the editor ever lags a system
  appearance switch, re-open the note before calling it a bug — and if it
  persists, that's a regression worth reporting.
- **`just ios-native` needs an already-booted simulator** — it does not
  auto-boot; run `just qa-claim ios` (or `just sim-boot` solo) first.
- Editor-affecting changes (`src/`, `packages/editor`) need a rebuilt editor
  bundle: `just ios-native` runs `vite build --config vite.editor.config.ts`
  every time, so a plain rebuild+reinstall picks them up.

# iOS — native SwiftUI app on the simulator

The shipping iOS app is the native SwiftUI shell in `apps/ios` (Rust core via
`futo-notes-ffi`, editor embedded as a WKWebView). There is no Tauri iOS shell
and no MCP bridge on iOS — you drive the app from outside via `xcrun simctl`
and `axe` ([AXe](https://github.com/cameroncooke/AXe)), and you verify editor
content through the filesystem (see [saved-content verification](ios-data-and-sync.md#the-flush-and-read-trick-editor-content-verification)).

`axe` replaced `idb` on 2026-07-27. This is not a cosmetic swap: `idb ui
describe-all` returns a shallow ~11-element tree on iOS 26.5 and never shows
the nav-bar controls, which cost us a 25-day false gap in `docs/spec/nav.md`
(2026-07-02 → 2026-07-27) blaming SwiftUI for a tool's blind spot. `axe` reports them with labels and
identifiers, and taps them. Do not reintroduce `idb`.

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

Relaunch after a state change (the note scan runs at launch):

```bash
SIM=$(just sim-udid)
xcrun simctl terminate "$SIM" com.futo.notes.dev 2>/dev/null
xcrun simctl launch "$SIM" com.futo.notes.dev
```

## 3. Drive the UI with axe

### Read the screen

**Never read a raw `axe describe-ui` dump.** It is 254KB on the note list and
453KB with a sheet open — mostly unnamed layout Groups. Use the summarizer,
which keeps only nodes with identity and marks untappable ones:

```bash
SIM=$(just sim-udid)
node scripts/describe-ios-ui.mjs --udid $SIM                        # whole screen, ~10KB
node scripts/describe-ios-ui.mjs --udid $SIM --type Button --on-screen-only
node scripts/describe-ios-ui.mjs --udid $SIM --label-contains "Qa-note"
node scripts/describe-ios-ui.mjs --udid $SIM --actions-only          # hidden affordances
node scripts/describe-ios-ui.mjs --udid $SIM --all                   # incl. unlabelled nodes
node scripts/describe-ios-ui.mjs --udid $SIM --id bold --json
```

The header reports how many nodes were **dropped** for carrying no id, label,
value, or action. Read it before concluding a control is missing: a control that
regressed into an unlabelled `Group` is dropped, not absent, and `--all` shows
it (that is the shape the nav controls had under `idb`).

`--label-contains` matches the whole label, not the trimmed column — an iOS row
label is `title, relative-date, body-preview`, so a body token like
`--label-contains "Body-token-88991"` finds the row even though the rendered
line stops at 34 characters.

`--actions-only` is the `docs/spec/AGENTS.md` hidden-affordance check: it lists
each row's `custom_actions` once, against the labeled row that owns them
(`Delete`/`Move` per note, `Delete Folder…` per folder). Check it before
declaring a feature missing.

**Do not infer which screen is frontmost from position in the tree.** `axe`
returns the whole window stack and the _covered_ screen comes first — with
Settings open, the first rows are still the note list. Confirm the screen with
a label predicate (`--label-contains "Share crash"`), never by reading the head
or tail of a dump. Two false negatives during the AXe evaluation came from
exactly this.

### Act on it

```bash
axe tap --udid $SIM --id nav-settings --element-type Button --wait-timeout 5
axe tap --udid $SIM --label "Qa-note-1, 2 weeks ago, Body-token-88991 alpha bravo-77"
axe tap --udid $SIM -x 200 -y 300                     # coordinates when nothing else works
axe touch --udid $SIM -x 201 -y 293 --down --up --delay 1.0   # long-press → context menu
axe swipe --udid $SIM --start-x 201 --start-y 780 --end-x 201 --end-y 180 --duration 0.5
axe type "marker4242" --udid $SIM                     # into the focused field
axe button home --udid $SIM                           # lowercase; backgrounds the app
axe screenshot --udid $SIM --output shot.png
axe batch --udid $SIM --wait-timeout 8 \
  --step "tap --id nav-settings --element-type Button" --step "sleep 2" \
  --step "type 'hello'"                               # one HID session, one round trip
```

`axe type` sends HID keyboard events; its success does not prove every character
arrived or that the software keyboard remains visible. On iOS 27 HID text can
also deliver nothing: `IOS_TEXT_INPUT=softwareKeyboard just test-ios-stories`
uses real touches on the software keys instead. A story must confirm the saved
marker, not AXe's exit code. AXe can also report `No translation object` after
delivering a touch; the self-link story observes the expected rename/edit on
disk before deciding whether input failed. On iOS 26.x HID input can
hide the software keys even when the text arrives. When keyboard visibility,
virtual-key hit-testing, or the editor accessory is part of the assertion, tap
the currently visible keyboard keys with `axe tap` and re-read the tree after
each state change. If HID input hides the keys, tap the focused field again and
confirm the key frames returned before continuing. On a claimed iOS 26.5 sim, a
body edit moved `q` to y=959; tapping the editor brought it back to y=590 while
`AutomaticMinimizationEnabled` remained `1`. Do not type directly into a
frontmost Simulator window: host typing can connect the simulator's hardware
keyboard. That preference is not a reliable health check by itself; use actual
on-screen key frames and read the saved note from disk to verify text.

`--element-type` is effectively mandatory: every nav item appears twice, as a
`Group` and as the concrete control, and a bare `--id` refuses to act
(`Multiple (2) accessibility elements matched`). Prefer `--wait-timeout` over
`sleep` — it waits for the element instead of guessing, which also handles the
"tree is briefly an unlabeled Group right after a screen push" case.

### Hold-then-drag: neither `swipe` nor `drag` can express it

A long press that then moves — the iOS block-drag gesture, and anything
Notion-shaped — cannot be driven by `axe swipe` or `axe drag`. Both apply
`--pre-delay` BEFORE touch-down, so the finger is already moving when it lands
and the app sees an ordinary scroll. Verified on AXe 1.8.0 with both verbs, at
`--pre-delay` up to 1.2s: the editor's 340ms lift never fired.

What works is one `touch` per position, because CoreSimulator's digitizer has no
distinct move event — a second `--down` at a new point IS a move:

```bash
axe touch -x 200 -y 300 --down --udid $SIM   # finger lands, nothing else
sleep 0.7                                     # past the app's 340ms lift
axe touch -x 200 -y 360 --down --udid $SIM   # a move, not a second touch
axe touch -x 200 -y 420 --down --udid $SIM
axe touch -x 200 -y 420 --up   --udid $SIM   # release commits
```

Each step is a separate process, and the touch survives between them, which is
the other half of the value: you can `axe screenshot` (or read the vault, or
`describe-ios-ui`) BETWEEN steps and see the lift, the ghost and the drop
indicator as separate frames. `axe batch` keeps one HID session if you want the
whole gesture in a single round trip.

### Rules that stop silent failures

Each of these was observed on iOS 26.5 / AXe 1.8.0. All but the last fail
_successfully_ — they print `✓` and change nothing.

- **Never use `gesture`.** `axe gesture scroll-down` exits 0, prints nothing,
  and does not scroll (verified: a row's frame y stayed at 736.7 with both
  default and explicit `--screen-width/--screen-height`). Use an explicit
  `swipe`; the same content then moved to 651.7.
- **Bounds-check before trusting a tap.** `axe tap` resolves an element's
  activation point and reports success even when it lies off-screen. An
  unscrolled horizontal scroll view reports its off-viewport children at their
  content coordinates, so on a 402pt screen the editor toolbar's `checklist`,
  `camera`, and `photo` come back at x-centers 420/477/523 and a tap on them
  does nothing. `describe-ios-ui.mjs` marks these `OFF-SCREEN`; use
  `--on-screen-only` to list only what will actually respond.
- **Keep swipes above y≈850.** A horizontal swipe at y=852 hits the
  home-indicator gesture and leaves the app. y=845 and y=838 are safe.
- **`--label` is exact-match, and row labels drift.** A note row's label
  embeds its relative timestamp, so the same row went from
  `'…, 2 weeks ago, …'` to `'…, 7 minutes ago, …'` mid-session. Prefer `--id`;
  when you must use `--label`, read the exact string from
  `describe-ios-ui.mjs --json` (its `label` is untruncated — the rendered
  summary trims to a 34-char column for width, `--json` never does).
- **`batch` is stateful.** A failed step leaves the app parked mid-flow and the
  next run's step 1 then fails against the wrong screen. Start every batch from
  a known state (terminate + launch).
- **Text starting with `-` is parsed as a flag.** `type "-marker-"` fails with
  `CommandError error 1`; use a marker without a leading dash.

### The editor toolbar is drivable

With the keyboard up, every accessory-toolbar item is in the tree under a
stable SF-Symbol identifier — `bold`, `italic`, `strikethrough`, `link`,
`textformat.size`, `text.quote`, `list.bullet`, `list.number`, `checklist`,
`camera`, `photo`, `keyboard.chevron.compact.down`. This is the surface
generated from `packages/editor/src/toolbar.ts` by `just toolbar-spec`, so it
can be QA'd directly:

```bash
axe tap --udid $SIM --id bold --element-type Button && axe type "boldtext" --udid $SIM
axe button home --udid $SIM && cat "$NOTES/<note>.md"   # → **boldtext**
```

On a 402pt-wide iPhone only the first eight sit inside the toolbar's viewport;
`checklist`, `camera`, and `photo` initially report at x-centers past the right
edge. Read their frames before tapping. `gesture` and some `swipe` paths can
report success without moving this horizontal row; use explicit move events:

```bash
axe drag --udid "$SIM" --start-x 330 --start-y "$TOOLBAR_Y" \
  --end-x 80 --end-y "$TOOLBAR_Y" --duration 0.6 --steps 30
```

Derive `TOOLBAR_Y` from a currently visible toolbar button's frame, keep the drag
inside the row, then re-read the tree and confirm the intended button's center
is on-screen before tapping. An off-screen AX frame is evidence to scroll,
not evidence the control is unreachable.

### What axe cannot reach

Out-of-process system UI — the "Save Password?" sheet, the Photos picker,
permission dialogs. This was true of `idb`; it has **not** been re-tested under
`axe` (the one attempt was invalidated when a bottom-edge swipe backgrounded
the app). Until someone checks, dismiss them by hand or restart the app to
bypass, and record affected stories as **Blocked (not drivable)**, not as
failures.

Coordinates in the tree are a11y points; × 3.0 = screenshot pixels on current
iPhone simulators.

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
  re-read the keyboard key frames before continuing; `axe type` can hide the
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

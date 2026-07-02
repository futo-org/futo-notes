# iOS — native SwiftUI app on the simulator

The shipping iOS app is the native SwiftUI shell in `apps/ios` (Rust core via
`futo-notes-ffi`, editor embedded as a WKWebView). There is no Tauri iOS shell
and no MCP bridge on iOS — you drive the app from outside via `xcrun simctl`
and `idb`, and you verify editor content through the filesystem (see "The
flush-and-read trick" below).

Debug builds install as `com.futo.notes.dev` ("FUTO Notes Dev") with notes at
`Documents/fake-notes` inside the app container — they can never touch the
production app or real notes.

## Toolchain

Everything below assumes: Xcode (with a downloaded simulator runtime),
`xcodegen` (brew), the Rust iOS targets (`aarch64-apple-ios-sim`), and `idb`
(`brew install idb-companion` + `pip install fb-idb`). `just ios-native` fails
with a clear message when something is missing.

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
Release the claim with `just qa-release` when the session is done.

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

## 3. Drive the UI with idb

`idb` reads the accessibility tree as structured JSON — labels, frames,
values, and `custom_actions`. Always prefer reading the tree over guessing
coordinates from screenshots.

```bash
SIM=$(just sim-udid)
idb list-targets | grep "$SIM"               # says "No Companion Connected"? → idb connect $SIM
idb ui describe-all --udid $SIM              # full a11y tree (JSON array)
idb ui describe-point --udid $SIM 201 400    # element under a point
idb ui tap --udid $SIM 201 400               # tap; add --duration 0.9 for long-press
idb ui swipe --udid $SIM --duration 0.5 201 780 201 180   # scroll up (from → to)
idb ui swipe --udid $SIM --duration 0.4 350 500 30 500    # swipe row left → reveal actions
idb ui text --udid $SIM 'grocery list'       # types into the focused field
idb ui button --udid $SIM HOME               # hardware button (HOME backgrounds the app)
```

To find an element, pipe `describe-all` through python/jq and filter by
`AXLabel`, then tap the **center** of its `frame` (`x+w/2, y+h/2`) — taps at
a frame's top edge hit the adjacent menu item. Long-press (`tap --duration
0.9`) opens row context menus; `custom_actions` in the tree lists swipe
actions that have no visible affordance — check them before declaring a
feature missing (see `docs/spec/AGENTS.md`).

Tree quirks (observed 2026-07): right after a screen push finishes,
`describe-all` can return just an unlabeled `Group` for a couple of seconds —
retry after a short sleep before concluding elements are missing. The
nav-bar controls (gear / cloud / `+` / back / `…`) appear as **unlabeled
Groups**, not labeled buttons — locate them on a screenshot instead
(coordinates in the tree are a11y points; × 3.0 = screenshot pixels on
current iPhone simulators).

**What idb cannot reach**: out-of-process system UI — the "Save Password?"
sheet, the Photos picker, permission dialogs. They don't appear in the a11y
tree. Dismiss them by hand, or restart the app to bypass. Record affected
stories as **Blocked (not idb-drivable)**, not as failures.

## 4. Screenshots, appearance, logs

```bash
just sim-screenshot ios-dark-list    # → ./test-screenshots/ios-dark-list.png
just sim-appearance dark             # system dark mode (app + editor follow live)
just sim-appearance light
```

The app logs mostly via `print()`, which only reaches a console-attached
launch — `log stream` alone misses it:

```bash
xcrun simctl terminate "$SIM" com.futo.notes.dev 2>/dev/null
xcrun simctl launch --console-pty "$SIM" com.futo.notes.dev   # stdout incl. print() (blocks; use run_in_background)
just sim-logs                        # os_log/WebKit stream for the app process
```

## 5. App data: seeding and verification

The debug app's vault is plain files in the app container — use it in both
directions (fixtures in, verification out):

```bash
NOTES="$(just sim-container)"        # → <container>/Documents/fake-notes
ls "$NOTES"
cat "$NOTES/grocery list.md"

# Seed fixtures, then relaunch so the scan picks them up:
mkdir -p "$NOTES/QA Folder"
printf '# Seeded\n\n- [ ] task\n' > "$NOTES/QA Folder/Seeded Note.md"
xcrun simctl terminate "$SIM" com.futo.notes.dev; xcrun simctl launch "$SIM" com.futo.notes.dev
```

**Empty-vault Welcome seed**: launching into a completely empty vault
auto-seeds `Welcome.md` — wipe-and-relaunch can never show the bare
"No notes yet" state. To reach true-empty, delete the last note **in-app**
(row long-press → Delete → confirm) and don't relaunch afterward.

### The flush-and-read trick (editor content verification)

The editor WKWebView is not reachable via CDP or JS from outside (no
`window.__testSync`, no MCP bridge on iOS). To verify what the editor holds:
background the app — backgrounding flushes pending edits to disk — then read
the file:

```bash
idb ui button --udid $SIM HOME
sleep 1
cat "$NOTES/<note>.md"
```

Type into the editor with `idb ui text` after tapping the title/body to
focus; verify the result on disk, not by screenshot-squinting.

**IME mangles typed text in note fields**: autocapitalize/predictive-text
rewrite things like `para-1-ios` → `Para-1-iOS` (the Sync settings fields
suppress this; note fields don't). `idb ui text` also APPENDS to prefilled
fields — clear them first (tap the field's right edge, then `idb ui key 42`
backspaces). For exact text, `xcrun simctl pbcopy $SIM` + long-press → Paste
usually works but has silently no-op'd in some fields — the robust pattern
is: use markers autocorrect can't rewrite (digits/hyphens), and verify
byte-for-byte on disk rather than trusting what the screen shows.

## 6. Sync features

The simulator shares the Mac's network — `http://127.0.0.1:<port>` reaches a
host server directly (unlike Android's `10.0.2.2`; a **physical** iPhone needs
the Mac's LAN IP instead). Native shells have no `__testSync` hook — connect
through Settings → Sync in the app UI. Server setup: see "Features that need a
sync server" in SKILL.md; when Docker/Postgres isn't available on this machine,
record sync happy-path stories as **Blocked**, not failed.

## Known gotchas

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

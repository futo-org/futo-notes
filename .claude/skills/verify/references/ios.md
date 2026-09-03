# iOS — native SwiftUI app on the simulator

The shipping iOS app is the native SwiftUI shell in `apps/ios` (Rust core via
`futo-notes-ffi`, editor embedded as a WKWebView). There is no Tauri iOS shell
and no MCP bridge on iOS — you drive the app from outside via `xcrun simctl`
and `axe` ([AXe](https://github.com/cameroncooke/AXe)), and you verify editor
content through the filesystem (see "The flush-and-read trick" below).

`axe` replaced `idb` on 2026-07-27. This is not a cosmetic swap: `idb ui
describe-all` returns a shallow ~11-element tree on iOS 26.5 and never shows
the nav-bar controls, which cost us a 25-day false gap in `docs/spec/nav.md`
(2026-07-02 → 2026-07-27) blaming SwiftUI for a tool's blind spot. `axe` reports them with labels and
identifiers, and taps them. Do not reintroduce `idb`.

Debug builds install as `com.futo.notes.dev` ("FUTO Notes Dev") with notes at
`Documents/fake-notes` inside the app container — they can never touch the
production app or real notes.

## Toolchain

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
each row's `custom_actions` once, against the labelled row that owns them
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

`--element-type` is effectively mandatory: every nav item appears twice, as a
`Group` and as the concrete control, and a bare `--id` refuses to act
(`Multiple (2) accessibility elements matched`). Prefer `--wait-timeout` over
`sleep` — it waits for the element instead of guessing, which also handles the
"tree is briefly an unlabeled Group right after a screen push" case.

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
  `camera`, and `photo` come back at x-centres 420/477/523 and a tap on them
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
axe button home --udid $SIM
sleep 1
cat "$NOTES/<note>.md"
```

Type into the editor with `axe type` after tapping the title/body to focus;
verify the result on disk, not by screenshot-squinting.

Two things the a11y tree _does_ give you without a disk read: the note title is
the editor's `TextField` `AXValue`, and the editor's accessory toolbar only
exists while the keyboard is up — so its presence is itself the evidence that a
field is focused.

**IME mangles typed text in note fields**: autocapitalize/predictive-text
rewrite things like `para-1-ios` → `Para-1-iOS` (the Sync settings fields
suppress this; note fields don't). `axe type` also APPENDS to prefilled
fields — clear them first (tap the field's right edge, then `axe key --keycode
42` backspaces). For exact text, `xcrun simctl pbcopy $SIM` + long-press →
Paste usually works but has silently no-op'd in some fields. The robust
patterns are: use markers autocorrect can't rewrite (digits/hyphens) and verify
byte-for-byte on disk, or tap the on-screen keyboard's own keys — they are in
the a11y tree with their letters as labels, so the IME never gets a say.

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
`checklist`, `camera`, and `photo` report at x-centres past the right edge and
cannot be tapped where they are. **This is a tooling limit, not an app defect.**
The bar is a real `ScrollView(.horizontal)` with a measured trailing inset that
peeks the edge icon (`EditorToolbar.swift` `computeSnap`, spec'd under "Scroll
affordance" in `docs/spec/editor.md`) — but `axe` cannot scroll it: `gesture` is
a no-op and an explicit `swipe` across the accessory row left every item's frame
unchanged. So the trailing items are **unexercised by automation**, and their
absence from `--on-screen-only` is not evidence they are broken. Verify them by
hand on a device, or on a wider simulator where they start on-screen.

## 6. Sync features

The simulator shares the Mac's network — `http://127.0.0.1:<port>` reaches a
host server directly (unlike Android's `10.0.2.2`; a **physical** iPhone needs
the Mac's LAN IP instead). Native shells have no `__testSync` hook — connect
through Settings → Sync in the app UI. Server setup: see "Features that need a
sync server" in SKILL.md; when this machine cannot reach the package registry
and `~/.cache/futo-notes` is cold, record sync happy-path stories as
**Blocked**, not failed.

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

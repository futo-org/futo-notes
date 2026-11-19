# Platform quirks

### PQ01

- **Rule:** Real platform behavior is verified on its actual webview rather than inferred from Chromium tests.
- **Why / history:** M22 explicitly excludes Playwright proof for WebView2 and real iOS keyboards; this ledger reports source evidence only.
- **Evidence:** AGENTS.md M22; docs/agents/platform-traps.md
- **Applies:** `slice 10`. **Check:** needs macOS WKWebView, Windows WebView2 and Linux WebKitGTK stories

### PQ02

- **Rule:** A simulator's word-boundary tap behavior does not justify overriding real iPhone taps.
- **Why / history:** 1460e3e7 reverted a correction after physical fingers proved character-precise; synthetic taps had changed WebKit's heuristics.
- **Evidence:** 1460e3e74; 3ebb6d6b5 (origin/fix/native-tap-caret-ime-dismiss, not main or desktop/new-editor)
- **Applies:** `mobile only`. **Check:** Historical native-touch trap, not a desktop hit-test rule

### PQ03

- **Rule:** An Android text widget avoids uneditable light-DOM controls that corrupt IME text offsets.
- **Why / history:** !453 found task checkboxes counted as an extra InputConnection character, dropping focus at task text start; hardware DEL did not reproduce it.
- **Evidence:** !453; #275; !474
- **Applies:** `mobile only`. **Check:** Android InputConnection path; test real keyboard deletions and spacebar caret motion

### PQ04

- **Rule:** Native-shell identity is asserted by the host rather than a dead isMobile constant.
- **Why / history:** !50 removed a hardcoded-false flag that disabled focus rules and leaked desktop selection controls onto phones.
- **Evidence:** !50; c672affd6
- **Applies:** `mobile only`. **Check:** Historical embed gating; desktop uses its own view

### PQ05

- **Rule:** A missing required WebView capability produces an actionable notice rather than a blank editor.
- **Why / history:** Huawei provider version numbers rejected working engines; !175 switched to syntax/mount capability checks.
- **Evidence:** !132; !175; docs/spec/editor/theming.md
- **Applies:** `mobile only`. **Check:** Android system WebView floor, not a desktop version gate

### PQ06

- **Rule:** Theme, caret color and load-bearing layout survive the browser engine's actual CSS support.
- **Why / history:** @layer and inset failures hid text and broke scrolling; unlayered rules also outrank layered link styles on modern browsers.
- **Evidence:** 26d8be13e; !132; !258; !364; src/AGENTS.md
- **Applies:** `desktop now`. **Check:** needs dark/light caret, heading and broken-link stories on desktop engines

### PQ07

- **Rule:** An OS file drop is decoded from the actual engine payload without relying solely on dataTransfer.files.
- **Why / history:** WebKitGTK Wayland advertised uri-list but carried a file URI as anchor text in HTML; packaged dragDropEnabled differed from dev.
- **Evidence:** docs/spec/editor/images.md; tests/image-drop.spec.ts
- **Applies:** `slice 5`. **Check:** needs packaged Linux file-manager drop evidence

### PQ08

- **Rule:** Renderer death cannot turn the last unreported page contents into an invented clean empty document.
- **Why / history:** The retired IME shield treated Chromium cancellation crashes; current save ownership must preserve the latest known draft when the renderer disappears.
- **Evidence:** docs/learnings/android-ime-renderer-crash-postmortem.md@0fad0917b^; editor-exits.md
- **Applies:** `desktop now`. **Check:** needs desktop renderer-loss story; no app/process actions in this research

### PQ09

- **Rule:** The retired Android IME shield is not reintroduced into the new editor.
- **Why / history:** Chromium/FUTO Keyboard fixed it upstream and the old Tauri-mobile injection no longer exists.
- **Evidence:** 71a89c248; docs/learnings/ime-shield-workaround.md@0fad0917b^
- **Applies:** `obsolete`. **Check:** Preserve the failure scenario, not the obsolete workaround

### PQ10

- **Rule:** Native keyboard accessory and back-swipe restrictions remain mobile-specific.
- **Why / history:** Find/format bars, 20pt edge gestures and first-responder timing do not define desktop mouse behavior.
- **Evidence:** !331; !334; cursor/native-touch-and-focus.md
- **Applies:** `mobile only`. **Check:** Desktop inherits the text/caret invariants, not UIKit/Compose mechanics

### PQ11

- **Rule:** A native editor initializes layout, theme, image resolution and note links before content and restores configuration after renderer loss.
- **Why / history:** !164 removed differing startup orders; Justin approved reporting version mismatch without blocking and initialized as readiness on 2026-08-03, replacing iOS's permanent blank editor on skew.
- **Evidence:** !164 description and Justin approval; docs/spec/editor/native-host-boot.md; editor-embed boot tests.
- **Applies:** `mobile only`. **Check:** Native bridge startup differs from the in-process desktop host; keep as prior art against blank-on-skew recovery.

### PQ12

- **Rule:** The macOS Edit menu preserves standard copy, paste and text-editing command delivery to the editor.
- **Why / history:** !243 found native accelerators handled before the webview and noted predefined Edit items are needed for Cmd+C/Cmd+V. Blanket key prevention to suppress the beep was rejected because it breaks input methods.
- **Evidence:** !243; native application menu.
- **Applies:** `desktop now`. **Check:** needs real WKWebView keyboard/menu stories; Chromium does not pin native menu routing.

### PQ13

- **Rule:** Outside edits in a portal-mounted vault are detected even when filesystem events do not arrive.
- **Why / history:** !245 measured inotify dropping host writes through the Flatpak document portal and used four-second polling; it records a remaining self-write suppression race within a poll interval.
- **Evidence:** !245; docs/spec/settings.md; docs/spec/sync.md.
- **Applies:** `slice 8`. **Check:** needs portal-vault outside-edit story including self-write plus concurrent external edit.

### PQ14

- **Rule:** A macOS Control-click opens its context menu without also activating the clicked surface.
- **Why / history:** !304 found WebKit delivering click and double-click alongside contextmenu; the guard is macOS-only because Ctrl-click is a tab-opening gesture elsewhere.
- **Evidence:** !304; desktop window input handling.
- **Applies:** `desktop now`. **Check:** needs real macOS context-click story on links and editor controls.

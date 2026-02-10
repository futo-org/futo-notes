# P0 IME Crash QA Checklist

## Scope
- Validate crash fixes for Android IME/composition flows.
- Validate drawer interactions during active composition.
- Validate no regression in editor usability after composition ends.

## Test Matrix
- Device:
  - Pixel 4a (or closest Android 13/14 device)
  - One Samsung device if available (Samsung Keyboard behaves differently)
- Keyboard:
  - Gboard (English)
  - Gboard (Japanese QWERTY / 12-key if available)
  - Samsung Keyboard (if device available)
- Build:
  - Debug native build from current branch

## Preconditions
1. Install latest build to device.
2. Ensure no older app instance is running in background.
3. Enable `adb logcat` capture before testing.

## Scenario A: Backspace-All + Hamburger (Colt Repro)
1. Open an existing note or create a new note.
2. Enter multiple lines of text.
3. Select all text and delete until editor is empty.
4. Tap hamburger menu immediately.
5. Repeat 10 times.

Expected:
- No app crash.
- Drawer opens/closes normally.
- No stuck keyboard or frozen editor state.

## Scenario B: Japanese QWERTY Composition + Drawer
1. Switch keyboard to Japanese QWERTY.
2. Type a phrase that remains in composing state (underlined candidate text visible).
3. While composition is active, tap hamburger menu.
4. Close drawer and continue typing/confirm composition.
5. Repeat 10 times.

Expected:
- No crash.
- Composition can be confirmed or canceled normally.
- Editor remains editable after drawer open/close.

## Scenario C: Composition End Recovery
1. Start composition (Japanese or emoji composition path).
2. Confirm composition.
3. Immediately type plain text and markdown markers (`**bold**`, `~~strike~~`).

Expected:
- Input remains responsive.
- Live markdown rendering resumes after composition ends.
- No duplicated or dropped characters.

## Scenario D: Rapid Open/Close Stress
1. Type continuously with IME.
2. Open/close drawer rapidly during and after composition.
3. Scroll note body and keep editing.

Expected:
- No crash, ANR, or broken scroll behavior.
- No blocked autosave warning/errors in logs.

## Log Review
- Capture: `adb logcat | grep -i "futo\\|chromium\\|codemirror\\|error\\|fatal"`
- Fail indicators:
  - `FATAL EXCEPTION`
  - WebView renderer crash
  - Unhandled JS exceptions tied to input/composition

## Pass Criteria
- All scenarios pass on at least one Pixel-class device with Japanese QWERTY.
- Zero crashes across 10 repetitions per scenario.

## MCP/LLM-Assisted Testing Notes
- Keep this checklist stable and machine-readable for future MCP workflows.
- Future automation hooks:
  - Scriptable steps with deterministic selectors (menu button, editor root).
  - Standardized log parser for crash signatures.
  - Device-run metadata output (device model, keyboard, Android version, pass/fail).

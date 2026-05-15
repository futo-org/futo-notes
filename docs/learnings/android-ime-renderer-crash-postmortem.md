# Android IME renderer crash post-mortem

Date: 2026-05-12

## Summary

FUTO Notes Dev crashed on a Moto G Power (2021), Android 11, when a user created
a new empty note and pressed backspace with FUTO Keyboard active. The WebView
renderer died with `SIGTRAP` inside `libwebviewchromium.so` (Android System
WebView 147.0.7727.137). The host app then crashed because our
`onRenderProcessGone` handler returned `false`, which tells Android WebView the
app did not handle renderer death.

## Impact

- User-visible app crash on empty-note backspace with FUTO Keyboard.
- Crash dialog contained crashpad minidump payload copied from logcat, producing
  unreadable reports that exceeded the crashlog server limit.
- Existing renderer-gone reports lacked the WebView version, memory state, and
  enough IME telemetry to distinguish OOM, Chromium regression, and app-side
  trigger.

## Root Cause

FUTO Keyboard's IME flow asks the focused WebView `InputConnection` for text
around the cursor before deleting. On Colt's device, the Chromium renderer hung
or slowed enough on the empty editable path that FUTO Keyboard's watchdog
canceled the query. That cancellation hit a Chromium 147 empty-editable edge
case and tripped an internal `CHECK()`, killing the renderer with `SIGTRAP`.

Once read queries were shielded, the next empty-backspace mutation path
(`deleteSurroundingText` and related cleanup calls) could still reach Chromium
and crash, so the final workaround shields both read queries and empty-body
backspace no-ops.

## Fixes

- `onRenderProcessGone` now writes an enriched `renderer_gone` report and
  returns `true`, then exits cleanly. This avoids the secondary crashpad fatal
  abort and preserves the report for next launch.
- Android logcat crash capture filters `crashpad` minidump payload lines and
  caps captured stack size so uploads stay readable and under server limits.
- `FutoImeConnection` wraps WebView `InputConnection` and, while the CodeMirror
  note body is focused, serves IME read queries from a Kotlin-side shadow instead
  of round-tripping to Chromium.
- Empty-body backspace cleanup calls are swallowed locally as no-ops while CM6
  is focused.
- The shield is explicitly gated by CM6 `focusin` / `focusout` so title fields
  and other inputs delegate to Chromium normally.
- `docs/learnings/ime-shield-workaround.md` documents the workaround and the build-time
  guard that keeps wry's generated `RustWebView.kt` override from disappearing.

## Lessons

- Renderer-death handlers must return `true` if the app handled the condition.
  Returning `false` converts a recoverable renderer death into a host-process
  crash.
- Crash reports need structured environment fields for WebView bugs: WebView
  package/version, `didCrash`, memory state, URL, and feature-specific telemetry.
- Workarounds at the WebView/InputConnection layer must be scoped to the active
  editor. A WebView has one input channel for every editable, so a body-editor
  workaround can break title inputs if it is not focus-gated.

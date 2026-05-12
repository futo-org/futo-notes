# IME Shield — Android renderer-crash workaround

**This is a load-bearing workaround.** If you are reading this because
you're about to remove some "weird IME wrapper code," stop and read the
whole document.

## The bug we're working around

Chromium **147.0.7727.x** Android System WebView crashes its renderer
process via `SIGTRAP` (`TRAP_BRKPT`) inside `libwebviewchromium.so` at
offset `0xdd0000` when an IME issues a surrounding-text query against
an **empty** editable.

Concrete user-visible trigger:

> Moto G Power (2021), Android 11, FUTO Keyboard active. Create a new
> (empty) note in FUTO Notes. Press backspace. Renderer crashes; on
> Android 11 / Chromium 147 that takes the host app down too.

The renderer's handler for `getTextBeforeCursor` /
`getSurroundingText` / `GET_WORD_RANGE_AT_CURSOR` trips a `CHECK()`
when the editable has length 0. FUTO Keyboard's `RichInputConnection`
(inherited from AOSP LatinIME) issues that query on backspace to figure
out what to delete (emoji surrogate pairs, list markers, composing
text). Gboard happens not to take the same code path on empty, which
is why the bug is keyboard-specific in observed reports.

## What the workaround does

**Eliminate the renderer's role in IME read-queries.** Maintain a
Kotlin-side shadow of CM6's text + selection. When the IME asks for
surrounding text, answer from the shadow — never from the renderer.
The Chromium `CHECK()` is unreachable because Chromium isn't asked.

**Only while the CM6 body editor is focused.** The WebView has one
InputConnection path for every editable in the page, including the note
title field. `EditorImeShield.active` is set by CM6 focusin/focusout handlers;
when it is false, `FutoImeConnection` delegates every read and mutation
to Chromium normally. This is load-bearing: without the focus gate, an
empty note body makes the wrapper swallow backspace in the title field.

```
JS (CM6 plugin)  ──▶  __FutoImeShield__.update(text, sel, serial)
                 ──▶  __FutoImeShield__.setActive(true/false)
                                │
                                ▼
                      EditorImeShield (Kotlin)
                       text / selStart / selEnd / active
                                ▲
                                │   reads
                                │
                     FutoImeConnection
                     (InputConnectionWrapper)
                                ▲
                                │   returned from
                                │
                  RustWebView.onCreateInputConnection
```

Mutations (`commitText`, `setComposingText`, etc.) **are not
intercepted in the general case** — they flow through to the
underlying IC, the renderer performs the real edits, CM6 receives the
resulting `beforeinput` events, and JS pushes the updated state back
into the shadow on the next update cycle.

**Exception: empty-body backspace housekeeping is intercepted while CM6
is focused.** After the first round of the workaround (which only
covered read queries), Colt's Moto crashed again on backspace — the
crash had moved farther through FUTO Keyboard's pipeline. So when the
shadow says the focused CM6 body editor is empty, the wrapper keeps the
entire no-op backspace/cleanup sequence out of Chromium:

- `deleteSurroundingText(beforeLength, afterLength)` → return `true`
- `deleteSurroundingTextInCodePoints(beforeLength, afterLength)` → return `true`
- `sendKeyEvent(KEYCODE_DEL)` → return `true`
- `beginBatchEdit()` / `endBatchEdit()` → return `true`
- `finishComposingText()` / empty `setComposingText(...)` /
  `setComposingRegion(...)` → return `true`
- `setSelection(...)` → return `true`
- `performPrivateCommand(...)` → return `true`
- `requestCursorUpdates(...)` → return `true`
- empty `commitText(...)`, null `commitCompletion(...)`, and null
  `commitCorrection(...)` → return `true`

These are no-ops anyway when the body doc is empty (the renderer would
have nothing to delete in the non-crashing case), so swallowing them is
behavior-preserving. Non-empty body docs and all non-CM6 editables
(title, dialogs, search inputs) are unaffected: deletion still passes
through to Chromium normally.

## Files involved

| File | What it does | Removing breaks |
|---|---|---|
| `apps/tauri/src-tauri/gen/android/app/src/main/java/com/futo/notes/{,dev/}EditorImeShield.kt` | Singleton holding the shadow and the CM6 `active` focus bit. `@JavascriptInterface` methods called from JS. | Shadow disappears; reads serve empty forever; autocorrect/swipe stops getting context. If `active` is removed, the shield can break title-field deletion. |
| `apps/tauri/src-tauri/gen/android/app/src/main/java/com/futo/notes/{,dev/}FutoImeConnection.kt` | `InputConnectionWrapper` subclass. While `active=true`, read queries pull from shadow and empty-body backspace is swallowed. While `active=false`, everything delegates to Chromium. | Wrapper gone → underlying IC handles reads → IPC to renderer → CRASH. Active gate gone → title/input regressions. |
| `apps/tauri/src-tauri/gen/android/app/src/main/java/com/futo/notes/{,dev/}MainActivity.kt` | `webView.addJavascriptInterface(EditorImeShield, "__FutoImeShield__")` in `onWebViewCreate`; renderer-gone reports include `imeShield=...` telemetry. | JS can't find `window.__FutoImeShield__`; shadow never gets populated; reads still come from shadow (safe-empty) but no autocorrect context. If telemetry is removed, the next failure becomes opaque again. |
| `apps/tauri/src-tauri/gen/android/app/src/main/java/com/futo/notes/dev/generated/RustWebView.kt` | `override fun onCreateInputConnection` returning `FutoImeConnection(super.onCreateInputConnection(outAttrs))`. **Auto-generated — injected at build time** via `WRY_RUSTWEBVIEW_CLASS_EXTENSION`. | Wrapper not installed → underlying IC handles reads → CRASH. |
| `apps/tauri/src-tauri/.cargo/config.toml` | Sets `WRY_RUSTWEBVIEW_CLASS_EXTENSION` via cargo's `[env]` section. **This is the source of truth for the override.** Cargo applies this on every build invocation, including when called via `cargo tauri`. | Same as above: override never lands in the APK. |
| `src/lib/imeShield.ts` | CM6 `ViewPlugin` calling `__FutoImeShield__.update(...)` on every doc/selection change and `setActive(true/false)` on CM6 focusin/focusout. | Shadow stays empty regardless of editor state; reads serve empty; autocorrect blind. If focus tracking is removed, title/input regressions return. |
| `src/components/MarkdownEditor.svelte` | Imports `imeShieldPlugin` and includes it in the `extensions` array. | Plugin never instantiated; shadow never populated. |

## Why we don't edit `RustWebView.kt` directly

`gen/android/app/src/main/java/com/futo/notes/dev/generated/RustWebView.kt`
carries `/* THIS FILE IS AUTO-GENERATED. DO NOT MODIFY!! */` and
**wry regenerates it on every `cargo tauri android build`** from
`~/.cargo/registry/src/.../wry-0.54.x/src/android/kotlin/RustWebView.kt`.
Any manual edit to the generated file is silently wiped on the next
build. The slim APK comes out missing the override and the crash
returns.

wry's `build.rs` exposes the supported extension hook
`WRY_RUSTWEBVIEW_CLASS_EXTENSION`. Whatever string this env var
contains is interpolated into the class body at the `{{class-extension}}`
placeholder in the template.

**Important gotcha** — `cargo tauri android build` filters
environment variables before invoking `cargo build`. Setting
`WRY_RUSTWEBVIEW_CLASS_EXTENSION` in the shell or justfile recipe
does NOT propagate through cargo-tauri to wry's build script. The
build "succeeds" with an empty substitution, the override never
lands, and the APK silently re-ships the renderer crash.

To bypass that filter, the override lives in cargo's `[env]` table
in `apps/tauri/src-tauri/.cargo/config.toml`. cargo applies entries
from that section on every build invocation, regardless of caller —
direct `cargo build`, `cargo tauri build`, or anything else that
ends up running cargo.

How it works end-to-end:

1. The override source lives in
   `apps/tauri/src-tauri/.cargo/config.toml` under `[env]` as a
   TOML triple-quoted multi-line string.
2. `cargo` (invoked by `cargo tauri android build`) reads
   `.cargo/config.toml` and sets `WRY_RUSTWEBVIEW_CLASS_EXTENSION`
   in the env it passes to build scripts.
3. wry's build.rs runs, sees the env var, and writes a regenerated
   `RustWebView.kt` containing our override at the
   `{{class-extension}}` placeholder.
4. Gradle compiles the regenerated Kotlin and packages the APK.
5. The `verify-ime-shield-in-generated` justfile recipe greps the
   regenerated file to confirm the override actually landed. If it
   didn't, the build fails loudly.

The pre-build `verify-ime-shield` recipe validates everything that's
*not* regenerated by wry: the config.toml itself, the
`FutoImeConnection.kt` / `EditorImeShield.kt` classes, the
JavascriptInterface bridge install in `MainActivity.kt`, and the JS
plugin wire-up.

**Direct `cargo tauri android build` is fine** in this setup,
because cargo's `[env]` propagates regardless. Still prefer the
`just android-*` recipes — they run both pre- and post-build
verification and will fail loudly if something has been removed.

## Verifying the workaround is intact

Pre-build (run anytime, fast):

```
just verify-ime-shield
```

Post-build (run after a successful `just android-*`):

```
just verify-ime-shield-in-generated
```

The two together cover both the source-side pieces and the wry-
regenerated `RustWebView.kt`. Both run as build dependencies on every
`just android-*` recipe so a regression can't ship.

## Reading crash-report telemetry

Renderer-gone reports include a line like:

```
imeShield=shadow(active=true,len=0,sel=0..0,serial=12) updates=12 resets=0 active=1 inactive=0 reads(before=3,after=0,selected=0,surrounding=0,extracted=1,caps=1) emptyDeletes(chars=2,codepoints=0,key=0) forwardedDeletes(chars=0,key=0)
```

Use it as a quick health check:

- all counters zero: the wrapper was bypassed, the wrong APK was installed, or
  `onCreateInputConnection` injection failed.
- read counters incrementing: FUTO Keyboard is asking our wrapper for context
  and Chromium is no longer seeing those read queries.
- `active=false` during a body-editor repro: the CM6 focus hook did not fire,
  so the wrapper delegated and the crash path may still be reachable.
- `active=true` while editing a title/input field: the CM6 blur hook did not
  fire, and title backspace may be swallowed.
- `emptyDeletes.*` / `emptyNoops.*` incrementing: backspace and the IME's
  empty-editor cleanup calls are being swallowed locally, as intended.
- `forwardedDeletes.*` incrementing on an empty-note repro: the JS shadow did
  not think the doc was empty; check the `shadow(len=...)` field and the CM6
  plugin update path.

## Verifying the workaround works on a device

1. Install the dev APK on an Android device with FUTO Keyboard set as
   the active IME.
2. Open FUTO Notes Dev.
3. Tap "New note" → empty `Untitled` body.
4. Press backspace on the soft keyboard.

**Expected:** nothing happens. No crash, no flash, no Chromium
"renderer process gone" event. The shadow is at `(text="", selStart=0,
selEnd=0)`; the IME's surrounding-text queries return empty; the
renderer is undisturbed.

To inspect the shadow from devtools while debugging:

```js
window.__FutoImeShield__.debugSummary()
// "len=0 sel=0..0 serial=42"
```

## Trade-offs and limitations

- **Lying to the IME about extracted text.** Some IMEs may behave
  oddly if `getExtractedText` returns content that doesn't match what
  Chromium sees in the renderer. In practice this is fine for
  CodeMirror — the shadow mirrors the same source-of-truth CM6 uses,
  so they agree.
- **Caps mode is always 0.** The shield returns 0 (no caps in effect)
  from `getCursorCapsMode` because we don't track Markdown sentence
  boundaries. This matters for keyboards that auto-capitalize the
  first letter of a sentence in plain text editors. CM6 is markdown
  code editing where autocaps would be annoying anyway.
- **Sync staleness window.** JS pushes the shadow update after CM6's
  transaction completes. Between the transaction completing and the
  JS bridge call reaching Kotlin (sub-millisecond on modern devices),
  an IME query racing with the JS update can see the previous serial.
  We default to empty in that race — which is the *safe* answer for
  the bug. A wrong-but-not-empty stale read is at worst a missed
  autocorrect on one character.

## Removing the workaround (future)

When Chromium upstream fixes the empty-editable surrounding-text
handler — track `chromium:bugs/<id>` here once filed — this workaround
can come out. To confirm before removing:

1. Update Android System WebView on a test Moto G Power (2021) to the
   fixed Chromium build.
2. Re-run the repro (new note → backspace via FUTO Keyboard).
3. Disable the shield by commenting out the override in
   `RustWebView.kt` and the import in `MarkdownEditor.svelte`.
4. Repro again. If it stays clean across 30 backspaces in a row, the
   upstream fix is good and the workaround can be deleted.

Do **not** remove the workaround based solely on Chromium release
notes — verify on the affected hardware + IME.

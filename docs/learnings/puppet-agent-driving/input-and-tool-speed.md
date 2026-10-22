## 4. Input, and the tool's own speed

*How does real input reach the apps safely, and how fast is the tool?*

**Real desktop input goes to one web view, never the window server.**
- **Why.** OS-level input goes to the focused window, and every build shares a binary name. An
  agent once found "the app" by name and typed into the real vault (M24).
- **What we built.** A debug-only command builds platform events in-process and hands them to this
  window's web view (WKWebView, WebKitGTK, WebView2). The web view sees them as trusted, and the
  window is never activated.
- **The spike corrected three assumptions:**
  1. `NSWindow.sendEvent` applies the key-window rule, so events go to the web view's responder
     methods instead.
  2. WebKit reads held buttons from the physical mouse, so debug builds swizzle
     `pressedMouseButtons`.
  3. A drag starting on selected text began an OS drag that wedged the window, so the inspector
     cancels `dragstart`.
- **Target check.** Every desktop call is first vetted by `scripts/qa-target.mjs`: the port must
  belong to a debug build of this worktree.

**A hidden window behaves differently.** The app's window is normally hidden during runs, and WebKit
then updates rendering only about every 200 ms.
- **Lost scroll notches.** A real scroll right after `ScrollBy` lost one wheel notch about once in
  five. `ScrollBy` now waits for the browser's own `scroll` event, and the result went to 20/20,
  twice.
- **App Nap.** Debug builds opt out of it. Calls that take 0.2 s had hung for 55–180 s while other
  worktrees compiled: `state` took 178 s under synthetic load, and 0.19 s after it. The starvation
  never reproduced afterwards, so the cure is unproven.

**Phones read their own screens.**
- **iOS.** The first reader shelled out to `axe`, at 0.6 s a read. The app now walks its own
  accessibility tree and keeps the elements UIKit's hit test reaches: 20–35 ms, against about
  250 ms.
- **Android** reads Compose semantics in 5–25 ms.
- **Keys.** One real key costs about 130 ms on iOS, against about 25 ms on Android. The CLI's own
  comment puts about 115 ms of each iOS send in connecting.

**Say what is wrong, not what it looks like.**
- **Android.** `adb forward` accepts a connection whether or not the app listens, so a dead app read
  as "malformed HTTP response". That would have kept agents off Android for a whole benchmark. The
  CLI now says the app is not running.
- **Phone taps.** A tap that lands on a row but reaches the app as zero touches now fails.

**The tool's own latency:**

| Measure | Before | After |
|---|---|---|
| `just puppet state` | 305 ms (rebuilt with `cargo run` each call) | 45 ms (runs the built binary unless a source is newer) |
| A replayed step, median of 95 | 147 ms | 43 ms |
| Polling a still-running verb | every 150 ms | every 20 ms (note switch 216 → 92 ms) |
| Creating an empty note | 1,630 ms (a flat wait) | 81 ms |
| A task reaching a far row | 2.8 s (real scroll) | 1.0 s (`ScrollToRow`) |

**None of it ships.**
- The desktop inspector is a dynamic import behind compile-time `TEST_HOOKS_ENABLED`.
- The Tauri input and link commands refuse outside debug builds.
- The iOS listener is `#if DEBUG`.
- Android's release source set registers nothing.

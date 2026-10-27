# Desktop screenshots and frame evidence

Resolve and verify the target through [the desktop workflow](desktop.md) before capture.

### Screenshots without stealing focus

Several sessions QA this app in parallel on one Mac, and the human is usually
typing in a terminal on another space. Anything that activates an app — `open -a`,
or the window-raise below — yanks them mid-sentence. Treat activation as a cost
you justify, not a default.

On macOS, a window's surface stays live and current while it sits on another
space, so capture it where it is. These native capture paths do not work on Linux.

| Situation                   | Use                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| macOS/Windows live bridge   | `just puppet screenshot` (the bridge's `capture_native_screenshot`; macOS ~19 ms, no extra permission) |
| macOS without a live bridge | `just qa-shot pid <pid>` \| `port <port>` \| `list`                                                    |
| Linux webview content       | `just puppet screenshot` (WebKitGTK's own snapshot; does not prove native window/compositor pixels)    |
| iOS simulator content       | `just sim-screenshot` (`simctl` needs no foreground app)                                               |

`just qa-shot` captures by window id (`screencapture -l`), which is why it
reaches a window on another space — that window is not "on screen", so a naive
enumeration misses it and tempts you into activating the app to make it appear.
It refuses any process `qa-target.mjs` will not verify as this worktree's debug
build: a capture reads pixels, and the release app's window shows the user's
real vault (M24).

`just sim-boot` no longer foregrounds Simulator.app. Pass `SHOW=1` when a human
wants to watch, or for the frame-dependent case below. On Xcode 27, which ships
no Simulator.app, `SHOW=1` refuses rather than opening DeviceHub.

### Frame-dependent measurements need a VISIBLE window

WebKit can suspend `requestAnimationFrame` while a window is occluded or the
Wayland session is locked. `document.hasFocus()` and `visibilityState` alone
cannot prove frame delivery. Run `await __tabSwitchProbe.check()` after loading
`scripts/perf/tab-switch-probe.js`; it checks the actual frame clock and returns
`framesLive` within 1200 ms. Bound any new frame waits too. The block-drag bench
also fails with a named stalled-frame error after 1200 ms without a frame.

Revealing a hidden verified dev window is permitted by the current
`core:window:allow-show` capability: evaluate
`await window.__TAURI__.window.getCurrentWindow().show()` through its bridge, then check
`isVisible()`. Showing does not establish focus or unoccluded frame delivery; check visibility
and actual frames separately before a paint measurement.

The webview's `getCurrentWindow().setFocus()` is denied by
`core:window:allow-set-focus`. On macOS, launching a second copy of the verified worktree debug
binary can request focus through `tauri-plugin-single-instance`. KDE Wayland may refuse
that request; repeating it does not unlock the session or prove live frames.
Never send OS-level input to raise a window (M24).

On Linux, start the complete owned test stack under a private compositor:

```bash
just desktop-headless just bench-block-drag current --repeat 1
# Or launch this worktree's dev stack there, then attach its verified bridge:
just desktop-headless just tauri-dev
```

This wraps `scripts/run-under-virtual-kwin.sh`, which needs `kwin_wayland` and
`dbus-run-session`. It owns a separate Wayland socket and D-Bus session, and
terminates only the compositor it started. It relays output after the command
exits. An existing app stays on its original compositor; restart the owned stack
inside the wrapper. A virtual compositor can still fail to deliver frames on
some hosts, so re-check `framesLive` there before claiming paint or scroll QA.
If no owned compositor delivers frames, record that leg as BLOCKED.

For tab-switch work that only needs the completed content transition,
`await __tabSwitchProbe.measure(7, 7, { frameless: true })` is supported. It
reports content timing without a paint claim; it cannot prove animation,
scrolling, visual stability, or painted latency.

### What the DOM says is not what the screen shows

For scroll/animation defects, in-page sampling can be structurally blind:
`getBoundingClientRect` reports geometry against the **main thread's** scroll
offset, while WebKit scrolls this container on its own thread — so a rAF probe
can report "rows cover the viewport" for a frame that painted empty. On macOS,
the bridge's `capture_native_screenshot` returns the real window surface in
~19 ms (fast enough to catch a 5-frame event); decode with `pngjs` (already a
dev dependency) and score the region. Linux's unimplemented native capture
cannot establish this evidence; a DOM screenshot does not substitute for it. Worked example + numbers:
`docs/perf/tab-switch-baseline.md`.

## WS1 — Stop disabling the GPU renderer on every Linux machine

**Outcome (2026-09-02).** Implemented after the GPU path improved rAF p95 from 191ms to 107ms
and reduced scroll hitch rate from 4.1% to 0.7%. The NVIDIA fallback remains because no verified
upstream/package floor made its removal safe. `FUTO_NOTES_SOFTWARE_RENDER=1` forces software;
the symmetric `=0` escape hatch was deliberately added to force GPU when detection is wrong.

**Today.** `apps/tauri/src-tauri/src/main.rs:8` sets `WEBKIT_DISABLE_DMABUF_RENDERER=1`
unconditionally on Linux, with the comment "blank windows / crashes on many Wayland + NVIDIA
configurations". `scripts/tauri-dev.mjs:31` sets the same variable for dev. WebKitGTK then
composites without its DMA-BUF path on Intel and AMD too, which costs scroll smoothness and CPU
on the machines that never had the problem.

**Goal.** The workaround applies only where the failure was observed, the user can force it
either way, and the dev recipe matches release behavior.

**Steps.**

1. Measure first, so the change has a number attached. On this machine (Fedora 44, WebKitGTK
   2.52), run the dev app twice, once with the variable and once with it removed from
   `scripts/tauri-dev.mjs`. Open a long note and scroll for ten seconds each. Two cheap
   instruments: `perf stat -p <pid>` or `top` for CPU of the `WebKitWebProcess`, and a
   requestAnimationFrame frame-time sampler injected through the MCP bridge
   (`webview_execute_js`) that logs p95 frame interval. Record both numbers in the commit body.
   If they are the same, stop here and record that too; the rest of WS1 is then not worth a
   risk on NVIDIA.
2. In process startup, replace the unconditional set with a decision:
   - If `WEBKIT_DISABLE_DMABUF_RENDERER` is already in the environment, leave it alone. The user
     or a distro wrapper has spoken.
   - Else, set it only when an NVIDIA GPU is present. Detect by reading
     `/sys/class/drm/card*/device/vendor` for `0x10de`, or `/proc/modules` for a line starting
     with `nvidia`. Prefer the sysfs read; it works without the module loaded. Put the detector
     in `platform_integration.rs` as a pure function over a string so it has a unit test, with
     the env logic beside it in `platform_integration::prepare_process`, before the Tauri builder
     initializes GTK/WebKit.
   - Offer an explicit override, `FUTO_NOTES_SOFTWARE_RENDER=1`, that forces the old behavior.
     Document it in `docs/spec/app.md` §Display backend next to the Wayland line.
3. Remove the variable from `scripts/tauri-dev.mjs` so dev exercises the same decision as
   release. That is the M17 sibling.
4. Optional, decide after step 1: WebKitGTK versions from 2.44 onward reportedly fixed most of
   the NVIDIA blank-window cases. If the AppImage's bundled WebKitGTK and the deb/rpm floor are
   both at or above a version you can confirm, the NVIDIA branch can be dropped entirely. Do
   not do this from memory; find the upstream bug and cite it in the commit.

**Verify.** Step 1 numbers. `cargo test -p futo-notes-tauri` for the detector. If an NVIDIA
machine is reachable, launch the installed rpm on it once. Spec: `docs/spec/app.md` §Display
backend gains one line for the rule and one for the override.

**Risk.** A detection miss on NVIDIA gives a blank window with no in-app way out. The env
override is the recovery path, so it must be documented where a user with a blank window can
find it (the README's Linux section, not only the spec).

---

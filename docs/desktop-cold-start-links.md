# Desktop cold-start link verification

The Tauri dev supervisor owns its Vite process. Ending the child app also ends that dev server,
so restarting its raw debug binary can leave a webview pointing at a dead dev URL. Verify a link
that arrives before the webview exists with an embedded frontend instead:

```bash
just test-desktop-cold-link
```

This Linux recipe first refuses an occupied worktree Vite port, builds current frontend/Rust
sources through `just build-desktop-test`, then starts an owned debug app directly. That build
uses the default `custom-protocol` feature, so its page loads from `tauri://localhost` with no
Vite server. It needs a working desktop session, like the other native desktop harnesses.

The fixture is fixed: `futonotes://license/not-a-license/not-an-activation`. It supplies no real
key or activation, and the malformed pair is rejected locally. The command accepts no URL
arguments. It checks the rendered invalid-link toast against catalog entries, verifies that the
inbox is drained and the app stays unlicensed, then restarts without a link and checks the clean
shell. This tests a cold launch; sending a link through a running app's bridge exercises another
lifecycle.

App data, note storage and Linux desktop-registration files are isolated under a newly created
`verification-runs/desktop-cold-link-*` directory. The shared launcher verifies the process with
`qa-target` before connecting to its bridge. Evidence includes app logs, binary identity, the
rendered result and restart state. The harness stops only the child processes it started and
retains evidence and owned data for review. It does not prove native screenshots or other
platforms' URL-delivery mechanisms.

For another CLI-driven startup fixture, `startDesktopTauriInstance` accepts literal `args` in
its options. A restart without `args` starts without the prior link; it reuses the data directories.

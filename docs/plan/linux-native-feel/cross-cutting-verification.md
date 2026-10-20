## Cross-cutting verification before each MR

- `just check` (lint, svelte-check, format, unit tests, Rust conformance, spec checks).
- `cargo test -p futo-notes-tauri` for anything under `apps/tauri`.
- `just tauri-dev` walk-through of the changed surface on GNOME, screenshots in the MR.
- `just deploy-rpm` for WS3 and WS5, since only the installed build shows the desktop entry
  and compositor grouping. Uninstall or reinstall the previous release afterward if this machine
  is also a daily-use machine; `just deploy-rpm` replaces `/usr/bin/futo-notes-tauri`.
- A Plasma check is wanted for WS3 and WS6. A Fedora KDE VM is enough; the display-backend
  learning in `docs/learnings/appimage-forced-x11.md` describes how to prove which backend the
  window is on if something looks wrong.

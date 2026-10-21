## Updates _(desktop self-update)_

- On launch (and then hourly), desktop builds that can self-update silently
  check the updater endpoint. A found update raises a small floating banner
  (bottom-right, above the sync status bar): a single **Update & restart**
  button — clicking anywhere on it downloads + verifies (minisign) + installs
  (showing a progress bar), then relaunches into the new version.
  → UpdateBanner.svelte, updateChecker.svelte.ts
- The launch/hourly checks are **silent**: a failed check (e.g. offline) never
  shows the banner or an error, and "you're already up to date" shows nothing.
  Only a user-initiated check (Settings → Updates) surfaces those outcomes; an
  install the user started from the banner surfaces its own error with a Retry.
- The banner has no dismiss control: it stays until the update is installed,
  the release is retracted, or updates are disabled in Settings.
  → UpdateBanner.svelte test "has no dismiss control"
- The banner and the Settings → Updates button share one state machine
  (`updateChecker`) — same pending version, progress, and install path — so a
  check or install from either is reflected in the other. The checker is
  started from App.svelte's background init and never gates render; it no-ops
  where self-update isn't possible (mobile/web, deb/rpm). → updates in
  settings.md, App.svelte, `apps/tauri/src-tauri/src/updater_commands.rs`

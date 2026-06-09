# Settings — Spec

## All platforms

- **Theme**: Light / Dark / Auto. Auto follows the system setting; selecting a
  theme applies immediately (no restart) and persists across restarts. →
  SettingsScreen.kt (SharedPreferences `theme_mode`) *(Android)*;
  theme.ts / SettingsScreen.svelte *(Tauri)*
- The app version is shown.

## Native shells

> **Gap:** the native **iOS** app has no Settings surface at all — the
> nav-bar cloud button opens the Sync sheet directly (server, password,
> Connect & Sync, status, plus a notes-folder path readout), so there is no
> theme control, account header, or about section (verified on simulator
> 2026-06-09). The lines below currently describe Android only.

- The account header shows connected vs. local state with a SYNCED / LOCAL
  badge; tapping it opens the Sync screen. → SettingsScreen.kt
- **Sync** group: hosted-sync status and server URL, both routing to the Sync
  screen.
- **About**: an open-source link (GitLab) and the app version.
- The Editor group states the "file over app" principle — notes are Markdown
  files. → SettingsScreen.kt

## Tauri shell

- Settings is a sheet/modal (mobile: bottom sheet over the current screen)
  with sections: Appearance, Sync, Crash reporting, Danger zone, and a
  version footer. Verified on Android Tauri 2026-06-09. →
  SettingsScreen.svelte (see settings-visual.md for the desktop layout)
- **Sync**: server URL + password inline with a Connect button and a
  "Last sync: …" line ("never" before the first sync). Once connected the
  section shows status/disconnect (see sync.md).
- **Crash reporting**: a "Share crash reports" toggle (anonymous crash logs);
  see app.md for the crash dialog flow.
- **Danger zone — Full reset**: permanently removes all notes and app data.
  First tap arms it ("Tap again to confirm" / "This cannot be undone!");
  second tap deletes with a blocking "Deleting all notes…" overlay. Sync is
  paused for the duration so a racing sync cannot resurrect files. →
  SettingsScreen.svelte, notes.svelte.ts `deleteAllNotes`
  > **Gap:** the native shells have no crash-reporting toggle, no full reset,
  > and no notes-directory affordances.

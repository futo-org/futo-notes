# Settings — Spec

## All platforms

- **Theme**: Light / Dark / Auto. Auto follows the system setting; selecting a
  theme applies immediately (no restart) and persists across restarts. →
  SettingsScreen.kt (SharedPreferences `theme_mode`) *(Android)*;
  theme.ts / SettingsScreen.svelte *(Tauri)*
- The app version is shown.

## Native shells

Both native shells have a full Settings surface (Android: drawer → Settings;
iOS: nav-bar gear → Settings sheet — the cloud button still opens the Sync
sheet directly). Verified on emulator + simulator 2026-06-09. →
SettingsScreen.kt *(Android)*, SettingsView.swift *(iOS)*

- **Sync** group: a single **"Self-hosted sync"** entry — a cloud icon, the
  connected-vs-local status, and a SYNCED / LOCAL badge — routes to the Sync
  screen. This one entry is the whole Sync surface: there is no separate
  account header above the group, and no separate "Server" row. Tapping it
  opens the Sync screen; when no server is connected yet, that screen points
  the user at the FUTO Notes server repo (see sync.md). →
  SettingsScreen.kt *(Android)*, SettingsView.swift *(iOS)*
- **Appearance**: the Theme Light/Dark/Auto control from "All platforms"
  applies immediately (iOS: `.preferredColorScheme` + the editor WebView
  theme follows; persisted in UserDefaults `futo.themeMode` / Android
  SharedPreferences `theme_mode`; survives relaunch — verified via the
  crash-test relaunch).
- **Storage**: a notes-directory path readout.
- **About**: an open-source link (GitLab) and the app version.
- **Crash reporting**: "Share crash reports" toggle with a nested "Always
  send automatically" (see app.md for the dialog flow).
- **Danger zone — Full reset**: same two-tap arm/confirm contract as the
  Tauri shell below — first tap arms ("Tap again to confirm" / "this cannot
  be undone!"), second tap deletes everything under the vault root
  (notes, folders, `.crashlogs`) behind a blocking "Deleting all notes…"
  overlay, with live sync paused and the connection + stored password
  dropped so a racing sync cannot resurrect files; the next launch reseeds
  the welcome note and stays LOCAL (verified on both 2026-06-09).
- Debug builds add a "Test crash" row to exercise the crash pipeline.

## Tauri shell

- Settings is a sheet/modal (mobile: bottom sheet over the current screen)
  with sections: Appearance, Sync, Crash reporting, Danger zone, and a
  version footer. → SettingsScreen.svelte (see settings-visual.md for the
  desktop layout)
- **Sync**: server URL + password inline with a Connect button and a
  "Last sync: …" line ("never" before the first sync). Once connected the
  section shows status/disconnect (see sync.md).
- **Crash reporting**: a "Share crash reports" toggle (anonymous crash logs);
  see app.md for the crash dialog flow.
- **Danger zone — Full reset**: permanently removes all notes and app data.
  First tap arms it ("Tap again to confirm" / "This cannot be undone!");
  second tap deletes with a blocking "Deleting all notes…" overlay. Sync is
  paused for the duration so a racing sync cannot resurrect files. The
  native shells implement the same contract (see "Native shells" above). →
  SettingsScreen.svelte, notes.svelte.ts `deleteAllNotes`

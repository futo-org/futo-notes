## Recorded implementation decisions

1. ~~Follow the system accent by default on Linux, with a persisted opt-out.~~ Reversed in
   review (!277): no other platform follows the desktop accent, and recolouring
   `--color-primary` repaints the brand mark. The accent read, the `linux-accent-changed` event,
   `accent.ts`, the settings toggle and `preferences.followSystemAccent` are all gone; only the
   light/dark `color-scheme` read remains.
2. Keep both the interface and editor on Barlow, with no font changer.
3. Prompt to copy an outside-vault markdown file into notes or cancel; never edit it in place or
   copy it silently.
4. Installed KDE testing showed a generic Alt+Tab icon because `FUTO Notes.desktop` did not match
   the `futo-notes-tauri` Wayland app ID. Keep that visible launcher for existing pins and add a
   hidden `futo-notes-tauri.desktop` identity alias to Debian and RPM packages.
5. ~~Persist the approved accent opt-out as `AppState.preferences.followSystemAccent`.~~
   Reversed with decision 1; `AppState.preferences` carries `theme` alone, as on `main`.
6. `feat/open-note-disposition-desktop` was inspected and is already merged into `main`
   (`c4e653fa`); this work reused its disposition rather than introducing a competing event.
9. Tauri's `Productivity` category is intentional because the Linux bundler maps it to the
   freedesktop `Office` category requested by WS5.

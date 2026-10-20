## All platforms

- **Theme**: Light / Dark / Auto. Auto follows the system setting; selecting a
  theme applies immediately (no restart) and persists across restarts. On
  desktop, Auto asks the OS directly (the desktop portal on Linux, the released
  window on macOS and Windows) and tracks later changes via the window/portal
  theme-change event — the webview's own `matchMedia` echoes the app's own last
  pin, so it is never the source of truth for Auto. →
  SettingsScreen.kt (SharedPreferences `theme_mode`) _(Android)_;
  theme.ts / createAppBootstrap.svelte.ts / SettingsScreen.svelte _(Tauri)_
- **Language** follows [localization.md](../localization.md). Desktop and Android
  provide a System-first language dropdown and apply changes immediately. iOS
  provides a row that opens the app's system Settings instead of an in-app
  dropdown. Both native rows carry a globe icon. The selection is local to the
  device and never syncs.
- On Linux desktop the current theme and later theme changes come from
  `org.freedesktop.portal.Settings`; startup uses `ReadOne` with a `Read`
  fallback, so Auto starts in the desktop's current appearance rather than
  waiting for a later signal. → desktop_settings.rs, theme.ts
- The app never follows the desktop accent color: `--color-primary` and the
  tokens derived from it stay FUTO brand orange on every platform, so only the
  light/dark choice is shared with the desktop. → theme.css,
  AppearanceSettingsSection.svelte
- The app version is shown.
- **License**: the License card (Unlicensed / Licensed / Expired, Buy, Enter
  license key, Remove) follows [license.md](../license.md). On the native shells it
  is the first thing at the top of Settings; on desktop the ambient label lives in
  the list view and opens Settings here. _(desktop)_ The License section sits
  after Updates and before the Danger zone, and **Full reset** clears the stored
  license along with every other preference. →
  `src/features/license/LicenseSettingsSection.svelte`, SettingsScreen.svelte
  (`initialSection`), `deleteAllNotes` in `src/features/notes/notes.svelte.ts`
  _(android)_ The License group is the first group of `SettingsScreen`, and the
  Danger-zone confirm clears the stored license with the vault. →
  `apps/android/app/src/main/java/com/futo/notes/ui/LicenseSettingsSection.kt`,
  `SettingsScreen.kt`, `license/LicenseModel.clearForFullReset`

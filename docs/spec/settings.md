# Settings — Spec

- **Theme**: Light / Dark / Auto. Auto follows the system setting. The choice
  persists across restarts. → SettingsScreen.kt (SharedPreferences `theme_mode`)
  *(Android)*
- The account header shows connected vs. local state with a SYNCED / LOCAL
  badge; tapping it opens the Sync screen. → SettingsScreen.kt
- **Sync** group: hosted-sync status and server URL, both routing to the Sync
  screen.
- **About**: an open-source link (GitLab) and the app version.
- The Editor group states the "file over app" principle — notes are Markdown
  files. → SettingsScreen.kt

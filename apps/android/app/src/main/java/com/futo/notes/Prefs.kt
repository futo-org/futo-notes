package com.futo.notes

/**
 * The single definition of every SharedPreferences name/key the app uses —
 * screens and managers reference these instead of re-declaring string
 * literals (one definition, no drift).
 */
object Prefs {
    const val FILE = "futo_prefs"

    const val THEME = "theme_mode"

    // Vault storage location [app.md]. One of StorageMode (DEVICE/APP/INTERNAL).
    // Absent = undecided: a fresh install shows the storage picker; an existing
    // install (non-empty internal vault) is grandfathered on INTERNAL.
    const val STORAGE_MODE = "storage_mode"

    // Sync session persistence [sync.md:91]. The server URL is plain; the
    // password is Keystore-encrypted by SecureStore (iv + ciphertext only).
    const val SYNC_SERVER_URL = "sync_server_url"
    const val SYNC_PASSWORD_IV = "sync_password_iv"
    const val SYNC_PASSWORD_CT = "sync_password_ct"

    // Crash reporting [settings.md:43]. Enabled defaults ON; always-send OFF.
    const val CRASH_ENABLED = "crash_reporting_enabled"
    const val CRASH_ALWAYS_SEND = "crash_always_send"
}

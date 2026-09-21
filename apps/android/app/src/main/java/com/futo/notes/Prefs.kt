package com.futo.notes

/**
 * The single definition of every SharedPreferences name/key the app uses —
 * screens and managers reference these instead of re-declaring string
 * literals (one definition, no drift).
 */
object Prefs {
    const val FILE = "futo_prefs"

    const val THEME = "theme_mode"

    const val LANGUAGE = "language"

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

    // The paid client license [license.md § Storage]: the two plain strings a
    // license IS, app-private and inside the dev/prod-split package (M3), never
    // in the vault and never in the keystore — it is a receipt, not a secret.
    // Full reset wipes them like every other preference.
    const val LICENSE_KEY = "license_key"
    const val LICENSE_ACTIVATION = "license_activation"

    const val FEEDBACK_DRAFT = "feedback_draft"

    const val CRASHLOG_STAGING = "crashlog_staging"
}

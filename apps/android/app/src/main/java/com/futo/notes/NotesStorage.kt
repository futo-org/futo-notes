package com.futo.notes

import android.content.Context
import android.os.Build
import android.os.Environment
import java.io.File

/** Where the note vault lives on disk. Mirrors Obsidian's two storage modes. */
enum class StorageMode { DEVICE, APP, INTERNAL }

/**
 * The single source of truth for the vault location + how to move it.
 *
 *  - DEVICE   — a folder in shared storage (`Documents/FUTO Notes`) the user can
 *               open from the Files app, back up, and sync with other apps.
 *               Needs the "All files access" (`MANAGE_EXTERNAL_STORAGE`) special
 *               permission (Android 11+).
 *  - APP      — the app-specific external dir
 *               (`Android/data/<pkg>/files/futo-notes`): no permission, but
 *               invisible to the stock Files app on Android 11+ and deleted on
 *               uninstall.
 *  - INTERNAL — legacy app-private internal storage (`filesDir/futo-notes`), the
 *               pre-feature location. Existing installs are grandfathered here so
 *               an update never moves their notes silently; they opt in via
 *               Settings.
 *
 * The path-decision + migration logic are PURE (operate on [File]/booleans) so
 * they unit-test without the Android framework — mirroring
 * [SyncManager.defaultServer]'s testable selector. The [Context]/[Environment]
 * glue is the thin layer below.
 */
object NotesStorage {
    private const val VAULT_DIR = "futo-notes"

    /** dev/prod guard for DEVICE mode: the public Documents folder is NOT
     *  package-scoped, so a debug build must use a distinct folder name or a dev
     *  install would write into the production vault. (APP/INTERNAL already
     *  isolate via the `.dev` applicationId on their package-scoped paths.) */
    fun deviceFolderName(isDebug: Boolean): String =
        if (isDebug) "FUTO Notes Dev" else "FUTO Notes"

    /** DEVICE mode relies on All-files access, an Android 11+ (API 30) mechanism.
     *  On older devices only APP storage is offered. */
    fun deviceModeSupported(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R

    data class Startup(val mode: StorageMode?, val needsOnboarding: Boolean)

    data class StorageRecoveryDecision(
        val activeMode: StorageMode,
        val repairPreferenceTo: StorageMode?,
    )

    fun storageRecoveryDecision(
        savedMode: String?,
        pending: PendingStorageMigration,
    ): StorageRecoveryDecision {
        val activeMode = when (pending.phase) {
            StorageMigrationPhase.PREPARED -> pending.from
            StorageMigrationPhase.ACTIVATED -> pending.to
        }
        val saved = savedMode?.let { runCatching { StorageMode.valueOf(it) }.getOrNull() }
        return StorageRecoveryDecision(
            activeMode = activeMode,
            repairPreferenceTo = activeMode.takeIf { it != saved },
        )
    }

    /**
     * Decide the vault location at launch (PURE).
     *  - a saved mode wins (returning user).
     *  - else a non-empty internal vault = an existing install → grandfather on
     *    INTERNAL (never repoint silently).
     *  - else a fresh install → show the picker when DEVICE is available,
     *    otherwise default straight to APP (pre-Android-11).
     */
    fun decideStartup(
        savedMode: String?,
        internalVaultExists: Boolean,
        deviceModeSupported: Boolean,
    ): Startup {
        savedMode?.let { raw ->
            runCatching { StorageMode.valueOf(raw) }.getOrNull()?.let { return Startup(it, false) }
        }
        if (internalVaultExists) return Startup(StorageMode.INTERNAL, false)
        return if (deviceModeSupported) Startup(null, true) else Startup(StorageMode.APP, false)
    }

    /** Whether [dir] looks like an existing vault (a directory with any content). */
    fun looksLikeExistingVault(dir: File): Boolean =
        dir.isDirectory && (dir.listFiles()?.isNotEmpty() == true)

    // ── Android glue (exercised on-device, not in JVM unit tests) ──

    fun internalRoot(context: Context): File = File(context.filesDir, VAULT_DIR)

    fun appRoot(context: Context): File =
        File(context.getExternalFilesDir(null) ?: context.filesDir, VAULT_DIR)

    @Suppress("DEPRECATION")
    fun deviceRoot(isDebug: Boolean): File =
        File(
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS),
            deviceFolderName(isDebug),
        )

    fun rootFor(context: Context, mode: StorageMode, isDebug: Boolean): File = when (mode) {
        StorageMode.INTERNAL -> internalRoot(context)
        StorageMode.APP -> appRoot(context)
        StorageMode.DEVICE -> deviceRoot(isDebug)
    }

    /** True when DEVICE mode is writable RIGHT NOW (permission actually held). */
    fun hasDeviceAccess(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && Environment.isExternalStorageManager()

    /**
     * Picker default for first-run and Settings. INTERNAL is a legacy/grandfathered
     * storage mode, not a user-facing option; when Device storage is unavailable
     * (API < 30), App storage is the only valid picker target.
     */
    fun pickerInitialMode(initialMode: StorageMode, deviceModeSupported: Boolean): StorageMode =
        when {
            !deviceModeSupported -> StorageMode.APP
            initialMode == StorageMode.INTERNAL -> StorageMode.DEVICE
            else -> initialMode
        }

    // ── Migration (PURE) ──

    sealed interface MigrationOutcome {
        val migrated: Boolean get() = this is Migrated
        val files: Int get() = if (this is Migrated) this.files else 0

        data class Migrated(override val files: Int) : MigrationOutcome

        data object EmptySource : MigrationOutcome
        data object AlreadyAtDestination : MigrationOutcome
        data class Failed(val message: String) : MigrationOutcome
    }

    data class StorageSwitchDecision(
        val commitPreference: Boolean,
        val restart: Boolean,
        val requiresFinalization: Boolean,
        val feedback: String?,
    )

    /** The preference/restart boundary consumes only an explicit safe outcome. */
    fun storageSwitchDecision(outcome: MigrationOutcome): StorageSwitchDecision =
        when (outcome) {
            is MigrationOutcome.Failed ->
                StorageSwitchDecision(false, false, false, outcome.message)
            is MigrationOutcome.Migrated ->
                StorageSwitchDecision(true, true, true, null)
            MigrationOutcome.EmptySource,
            MigrationOutcome.AlreadyAtDestination,
            -> StorageSwitchDecision(true, true, false, null)
        }

}

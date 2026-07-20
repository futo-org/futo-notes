package com.futo.notes

import android.content.Context
import android.os.Build
import android.os.Environment
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest

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
        val feedback: String?,
    )

    /** The preference/restart boundary consumes only an explicit safe outcome. */
    fun storageSwitchDecision(outcome: MigrationOutcome): StorageSwitchDecision =
        when (outcome) {
            is MigrationOutcome.Failed -> StorageSwitchDecision(false, false, outcome.message)
            is MigrationOutcome.Migrated,
            MigrationOutcome.EmptySource,
            MigrationOutcome.AlreadyAtDestination,
            -> StorageSwitchDecision(true, true, null)
        }

    /**
     * Copy the whole vault tree (INCLUDING dotfiles — the `.futo` /
     * `.e2ee-state.json` sync state, `.crashlogs`, and images) from [from] to
     * [to], then VERIFY every relative path and file's size/content digest.
     * Copying happens in a sibling staging directory, and a non-empty destination
     * is never merged into or cleaned up. The source remains intact until
     * [finalizeMigration], which the Activity calls only after the new preference
     * is durably committed. Sync survives the move because the object map is
     * keyed by relative filename [sync.md], not absolute path.
     */
    fun migrate(
        from: File,
        to: File,
        copyTree: (File, File) -> Boolean = { source, staging ->
            source.copyRecursively(staging, overwrite = false)
        },
    ): MigrationOutcome {
        val source = runCatching { from.canonicalFile }.getOrElse {
            return MigrationOutcome.Failed("Unable to read the current notes folder.")
        }
        val destination = runCatching { to.canonicalFile }.getOrElse {
            return MigrationOutcome.Failed("Unable to resolve the new notes folder.")
        }
        if (!source.exists() || !source.isDirectory) {
            return MigrationOutcome.Failed("The current notes folder is unavailable. The storage mode was not changed.")
        }
        if (source == destination) return MigrationOutcome.AlreadyAtDestination

        val sourceManifest = runCatching { manifest(source) }.getOrElse {
            return MigrationOutcome.Failed("Unable to read every item in the current notes folder.")
        }
        if (sourceManifest.isEmpty()) return MigrationOutcome.EmptySource
        if (destination.exists() && (!destination.isDirectory || destination.listFiles()?.isNotEmpty() != false)) {
            val destinationManifest = runCatching { manifest(destination) }.getOrNull()
            return if (destinationManifest == sourceManifest) {
                MigrationOutcome.Migrated(
                    files = sourceManifest.values.count { !it.isDirectory },
                )
            } else {
                MigrationOutcome.Failed(
                    "The new notes folder already contains different files. Neither vault was changed.",
                )
            }
        }

        val parent = destination.parentFile
            ?: return MigrationOutcome.Failed("Unable to resolve the new notes folder's parent.")
        if (!parent.exists() && !parent.mkdirs()) {
            return MigrationOutcome.Failed("Unable to create the new notes folder's parent.")
        }
        val staging = runCatching {
            Files.createTempDirectory(parent.toPath(), ".${destination.name}.migration-").toFile()
        }.getOrElse {
            return MigrationOutcome.Failed("Unable to create a temporary folder for the verified copy.")
        }

        val staged = runCatching { copyTree(source, staging) }.getOrDefault(false)
        if (!staged || runCatching { manifest(staging) }.getOrNull() != sourceManifest) {
            staging.deleteRecursively()
            return MigrationOutcome.Failed("The notes copy could not be verified. The original notes are unchanged.")
        }

        if (destination.exists()) {
            if (!destination.isDirectory || destination.listFiles()?.isNotEmpty() != false) {
                staging.deleteRecursively()
                return MigrationOutcome.Failed("The new notes folder changed during migration. Neither vault was overwritten.")
            }
            if (!destination.delete()) {
                staging.deleteRecursively()
                return MigrationOutcome.Failed("The empty destination folder could not be prepared.")
            }
        }
        if (!staging.renameTo(destination)) {
            staging.deleteRecursively()
            return MigrationOutcome.Failed("The verified notes copy could not be installed. The original notes are unchanged.")
        }
        if (runCatching { manifest(destination) }.getOrNull() != sourceManifest) {
            return MigrationOutcome.Failed("The installed notes copy could not be verified. The original notes are unchanged.")
        }

        val fileCount = sourceManifest.values.count { !it.isDirectory }
        return MigrationOutcome.Migrated(fileCount)
    }

    /** Remove the old vault only after the new storage preference is durable. */
    fun finalizeMigration(from: File, to: File): Boolean {
        val source = runCatching { from.canonicalFile }.getOrNull() ?: return false
        val destination = runCatching { to.canonicalFile }.getOrNull() ?: return false
        if (source == destination || !source.exists()) return true
        val sourceManifest = runCatching { manifest(source) }.getOrNull() ?: return false
        val destinationManifest = runCatching { manifest(destination) }.getOrNull() ?: return false
        if (sourceManifest != destinationManifest) return false
        return source.deleteRecursively()
    }

    private data class ManifestEntry(
        val isDirectory: Boolean,
        val size: Long,
        val digest: String,
    )

    private fun manifest(root: File): Map<String, ManifestEntry> {
        if (!root.exists()) return emptyMap()
        require(root.isDirectory) { "Vault root is not a directory" }
        return root.walkTopDown().drop(1).associate { item ->
            val relativePath = item.relativeTo(root).invariantSeparatorsPath
            if (item.isDirectory) {
                relativePath to ManifestEntry(isDirectory = true, size = 0, digest = "")
            } else {
                relativePath to ManifestEntry(
                    isDirectory = false,
                    size = item.length(),
                    digest = sha256(item),
                )
            }
        }
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().buffered().use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}

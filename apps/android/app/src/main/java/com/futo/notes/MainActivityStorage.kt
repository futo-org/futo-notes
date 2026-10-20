package com.futo.notes

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.widget.Toast
import androidx.lifecycle.lifecycleScope
import com.futo.notes.storage.activateStagedStorageMigration
import com.futo.notes.storage.adoptExistingVault
import com.futo.notes.storage.NotesStorage
import com.futo.notes.storage.PendingStorageMigration
import com.futo.notes.storage.StorageActivationOutcome
import com.futo.notes.storage.storageAdoptionFailureMessage
import com.futo.notes.storage.StorageAdoptionOutcome
import com.futo.notes.storage.StorageMigrationPhase
import com.futo.notes.storage.StorageMode
import com.futo.notes.storage.storageRefusalMessage
import com.futo.notes.storage.StorageStartupRecovery
import com.futo.notes.storage.storageSwitchFailureMessage
import com.futo.notes.storage.storageSwitchFailureStage
import com.futo.notes.storage.storageSwitchPlan
import com.futo.notes.storage.StorageSwitchPlan
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal fun MainActivity.applyStorageStartup(recovery: StorageStartupRecovery) {
    storageRecoveryFailure.value = recovery.failure
    if (recovery.failure != null) android.util.Log.e("FutoStorage", "Storage recovery failed")
    val startup = recovery.startup
    if (startup == null) {
        storageResolving.value = false
        return
    }
    if (startup.needsOnboarding) {
        showOnboarding.value = true
    } else {
        val mode = startup.mode!!
        // Pin the derived mode (grandfathered INTERNAL / pre-11 APP) so later
        // launches resolve deterministically without re-detecting.
        prefs.edit().putString(Prefs.STORAGE_MODE, mode.name).apply()
        if (mode == StorageMode.DEVICE && !NotesStorage.hasDeviceAccess()) {
            showRegrant.value = true
        } else {
            initVault(NotesStorage.rootFor(this, mode, BuildConfig.DEBUG))
        }
    }
    storageResolving.value = false
}

/** Settings change-location confirm: migrate the vault, then relaunch. */
internal fun MainActivity.performStorageChange(mode: StorageMode) {
    if (mode == currentMode()) return
    if (mode == StorageMode.DEVICE && !NotesStorage.deviceModeSupported()) {
        Toast.makeText(
            this,
            localization.localizedText("storage.android.permission.unsupported"),
            Toast.LENGTH_LONG,
        ).show()
        return
    }
    if (mode == StorageMode.DEVICE) requestDeviceAccess { planStorageChange(StorageMode.DEVICE) }
    else planStorageChange(mode)
}

/**
 * Copying the vault and re-pointing at an existing one are different
 * operations, so what is already in the target decides which one runs.
 */
internal fun MainActivity.planStorageChange(newMode: StorageMode) {
    if (storageSwitching.value) return
    val current = store.value ?: return
    val to = NotesStorage.rootFor(this, newMode, BuildConfig.DEBUG)
    lifecycleScope.launch {
        when (val plan = storageSwitchPlan(current.inspectVaultDestination(to), sync.connected)) {
            StorageSwitchPlan.Migrate -> performSwitch(newMode)
            is StorageSwitchPlan.OpenExisting ->
                pendingStorageAdoption.value = PendingStorageAdoption(newMode, plan)
            is StorageSwitchPlan.Refuse -> {
                android.util.Log.e("FutoStorage", "Storage switch refused: ${plan.reason}")
                Toast.makeText(
                    this@planStorageChange,
                    localization.localizedText(storageRefusalMessage(plan.reason).path),
                    Toast.LENGTH_LONG,
                ).show()
            }
        }
    }
}

/**
 * Point the app at the notes already in [mode]'s folder. Nothing is copied,
 * merged, or deleted, so the previous folder keeps every note it has — the
 * user has already been shown both sides. Relaunching is what rebuilds every
 * vault-derived object against the new root (M4); the drafts are flushed
 * first because `exit(0)` would otherwise drop a retained one.
 */
internal fun MainActivity.adoptExistingStorage(adoption: PendingStorageAdoption) {
    val current = store.value ?: return
    // No `storageSwitching` guard: the confirmation has already been consumed
    // by the time this runs, so bailing out here would swallow the user's
    // answer with nothing on screen to explain it. The vault gate below is the
    // real serialization, and it refuses out loud.
    storageSwitching.value = true
    if (!current.tryBeginStorageMigration()) {
        storageSwitching.value = false
        Toast.makeText(
            this,
            localization.localizedText("storage.android.saveInProgress"),
            Toast.LENGTH_LONG,
        ).show()
        return
    }
    lifecycleScope.launch {
        // The step order and every failure message live in adoptExistingVault
        // so they can be unit-tested; this only supplies the effects.
        val outcome = adoptExistingVault(
            mode = adoption.mode,
            isSyncConnected = { sync.connected },
            flushDrafts = { current.flushDraftsForVaultHandoff() },
            clearJournal = {
                withContext(Dispatchers.IO) { storageMigrationJournal.clear() }.isSuccess
            },
            // commit() — restartApp() kills the process before an async apply()
            // would flush (see performSwitch).
            commitPreference = { mode ->
                withContext(Dispatchers.IO) {
                    prefs.edit().putString(Prefs.STORAGE_MODE, mode.name).commit()
                }
            },
        )
        when (outcome) {
            StorageAdoptionOutcome.Restart -> restartApp()
            is StorageAdoptionOutcome.KeepCurrent -> {
                android.util.Log.e("FutoStorage", "Storage adoption failed: ${outcome.failure}")
                current.resumeAfterStorageMigrationFailure()
                storageSwitching.value = false
                Toast.makeText(
                    this@adoptExistingStorage,
                    localization.localizedText(
                        storageAdoptionFailureMessage(outcome.failure).path,
                    ),
                    Toast.LENGTH_LONG,
                ).show()
            }
        }
    }
}

internal fun MainActivity.performSwitch(newMode: StorageMode) {
    if (storageSwitching.value) return
    val current = store.value ?: return
    val previousMode = currentMode()
    val to = NotesStorage.rootFor(this, newMode, BuildConfig.DEBUG)
    storageSwitching.value = true
    if (!current.tryBeginStorageMigration()) {
        storageSwitching.value = false
        Toast.makeText(
            this,
            localization.localizedText("storage.android.saveInProgress"),
            Toast.LENGTH_LONG,
        ).show()
        return
    }
    // Latch BOTH vault owners synchronously. onStop may fire as soon as the
    // picker Activity loses focus; it must not abort the graceful sync stop.
    sync.beginStorageMigration()
    current.suppressAutoPush = true
    lifecycleScope.launch {
        val prepared = PendingStorageMigration(
            from = previousMode,
            to = newMode,
            phase = StorageMigrationPhase.PREPARED,
            cleanupRequired = false,
        )
        val outcome = runCatching {
            sync.quiesceForStorageMigration()
            withContext(Dispatchers.IO) {
                storageMigrationJournal.write(prepared).getOrThrow()
            }
            current.migrateVault(to)
        }.getOrElse {
            NotesStorage.MigrationOutcome.Failed(
                "The notes folder could not be moved. The original notes are unchanged.",
            )
        }
        val decision = NotesStorage.storageSwitchDecision(outcome)
        val failureStage = storageSwitchFailureStage(decision)
        val activation = activateStagedStorageMigration(
            prepared = prepared,
            decision = decision,
            writeJournal = { record ->
                withContext(Dispatchers.IO) {
                    storageMigrationJournal.write(record).isSuccess
                }
            },
            finalizeSource = {
                runCatching {
                    current.finalizeVaultMigration(
                        to,
                        allowSourceRemoval = previousMode != StorageMode.DEVICE,
                    )
                }.getOrNull()
            },
            commitPreference = { mode ->
                withContext(Dispatchers.IO) {
                    prefs.edit().putString(Prefs.STORAGE_MODE, mode.name).commit()
                }
            },
            clearJournal = {
                withContext(Dispatchers.IO) { storageMigrationJournal.clear() }
            },
        )
        if (activation == StorageActivationOutcome.Restart) {
            restartApp()
            return@launch
        }

        // PREPARED (or no journal) means the source remains authoritative.
        // Clearing is best effort: a surviving PREPARED record also selects
        // the source on the next launch.
        withContext(Dispatchers.IO) {
            storageMigrationJournal.clear()
            prefs.edit()
                .putString(Prefs.STORAGE_MODE, previousMode.name)
                .commit()
        }
        current.suppressAutoPush = false
        current.resumeAfterStorageMigrationFailure()
        storageSwitching.value = false
        sync.resumeAfterStorageMigrationFailure()
        Toast.makeText(
            this@performSwitch,
            storageSwitchFailureMessage(failureStage).let {
                localization.localizedText(it.path, it.arguments)
            },
            Toast.LENGTH_LONG,
        ).show()
        if (activation is StorageActivationOutcome.KeepSource) {
            android.util.Log.e(
                "FutoStorage",
                "Storage switch failed at $failureStage: ${activation.failure}",
            )
        }
    }
}

/**
 * Request the "All files access" special permission (Android 11+). The
 * settings screen returns no result code, so [allFilesLauncher]'s callback
 * re-checks [NotesStorage.hasDeviceAccess] and runs [onGranted].
 */
internal fun MainActivity.requestDeviceAccess(onGranted: () -> Unit) {
    if (!NotesStorage.deviceModeSupported()) {
        Toast.makeText(
            this,
            localization.localizedText("storage.android.permission.unsupported"),
            Toast.LENGTH_LONG,
        ).show()
        return
    }
    if (NotesStorage.hasDeviceAccess()) { onGranted(); return }
    pendingDeviceAction = onGranted
    val perApp = Intent(
        Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
        Uri.fromParts("package", packageName, null),
    )
    runCatching { allFilesLauncher.launch(perApp) }.onFailure {
        // Some OEMs lack the per-app deep link — fall back to the global list.
        runCatching { allFilesLauncher.launch(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)) }
    }
}

internal fun MainActivity.restartApp() {
    packageManager.getLaunchIntentForPackage(packageName)?.let {
        it.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NEW_TASK)
        startActivity(it)
    }
    Runtime.getRuntime().exit(0)
}

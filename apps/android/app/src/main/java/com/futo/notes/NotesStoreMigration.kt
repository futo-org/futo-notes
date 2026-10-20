package com.futo.notes

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import com.futo.notes.storage.NotesStorage
import com.futo.notes.storage.StorageDestination
import uniffi.futo_notes_ffi.NoteMutation
import uniffi.futo_notes_ffi.VaultDestinationState
import uniffi.futo_notes_ffi.VaultMigrationStatus
import uniffi.futo_notes_ffi.VaultMigrationFinalization
import java.io.File

/** Claim exclusive vault access for migration. Refuse while a write is
 * active because image saves include their later WebView insertion. */
fun NotesStore.tryBeginStorageMigration(): Boolean =
    storageMigrationGate.tryBeginMigrationWhenIdle()

/** What [to] already holds, so the caller can choose between copying the vault
 *  into it and opening it. Read-only on both folders. */
suspend fun NotesStore.inspectVaultDestination(to: File): StorageDestination =
    withCore {
        val inspection = core.inspectVaultDestination(to.absolutePath)
        when (inspection.state) {
            VaultDestinationState.EMPTY -> StorageDestination.Empty
            VaultDestinationState.OCCUPIED ->
                StorageDestination.Occupied(
                    notes = inspection.notes.toInt(),
                    lastModifiedMs = inspection.lastModifiedMs.toLong(),
                )
            VaultDestinationState.UNUSABLE -> StorageDestination.Unusable
        }
    }

/**
 * Flush retained editor drafts and hold the vault gate across migration.
 * Existing store operations finish before the copy starts; the Activity
 * blocks new UI input and pauses sync before calling this method.
 */
suspend fun NotesStore.migrateVault(to: File): NotesStorage.MigrationOutcome {
    val drafts = pendingEditor.currentDrafts()
    val mutations = mutableListOf<NoteMutation>()
    val outcome = withContext(Dispatchers.IO) {
        storageMigrationGate.runMigration {
            if (!flushDraftsUnderGate(drafts, mutations)) {
                NotesStorage.MigrationOutcome.Failed(
                    "An open editor change could not be saved. The storage mode was not changed.",
                )
            } else {
                val staged = core.stageVaultMigration(to.absolutePath)
                when (staged.status) {
                    VaultMigrationStatus.MIGRATED ->
                        NotesStorage.MigrationOutcome.Migrated(staged.files.toInt())
                    VaultMigrationStatus.EMPTY_SOURCE ->
                        NotesStorage.MigrationOutcome.EmptySource
                    VaultMigrationStatus.ALREADY_AT_DESTINATION ->
                        NotesStorage.MigrationOutcome.AlreadyAtDestination
                }
            }
        }
    }
    mutations.forEach(::applyMutation)
    return outcome
}

/**
 * Persist every unsaved draft before the process is relaunched onto a
 * different notes folder. Opening an existing folder copies nothing, so this
 * is the only thing standing between a retained draft and a `exit(0)` that
 * would drop it. Holds the same gate as [migrateVault].
 */
suspend fun NotesStore.flushDraftsForVaultHandoff(): Boolean {
    val drafts = pendingEditor.currentDrafts()
    val mutations = mutableListOf<NoteMutation>()
    val flushed = withContext(Dispatchers.IO) {
        storageMigrationGate.runMigration { flushDraftsUnderGate(drafts, mutations) }
    }
    mutations.forEach(::applyMutation)
    return flushed
}

/** Returns false when any draft could not be persisted. Callers hold the gate. */
internal fun NotesStore.flushDraftsUnderGate(
    drafts: List<PendingDraft>,
    mutations: MutableList<NoteMutation>,
): Boolean =
    drafts.none { draft ->
        try {
            core.flushDraft(draft.id, draft.base, draft.content).mutation?.let(mutations::add)
            false
        } catch (e: Exception) {
            android.util.Log.e("NotesStore", "storage-switch draft flush failed for ${draft.id}", e)
            true
        }
    }

/** Re-open the old root after a migration or preference-commit failure. */
fun NotesStore.resumeAfterStorageMigrationFailure() {
    storageMigrationGate.resume()
}

suspend fun NotesStore.finalizeVaultMigration(
    to: File,
    allowSourceRemoval: Boolean,
): VaultMigrationFinalization =
    withContext(Dispatchers.IO) {
        storageMigrationGate.runMigration {
            core.finalizeVaultMigration(to.absolutePath, allowSourceRemoval)
        }
    }

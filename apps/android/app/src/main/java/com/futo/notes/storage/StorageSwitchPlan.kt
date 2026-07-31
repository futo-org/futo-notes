package com.futo.notes.storage

/** What a candidate notes folder already holds. */
sealed interface StorageDestination {
    /** Absent, or present with no entries — a whole-vault copy can land here. */
    data object Empty : StorageDestination

    /** Already holds entries, so it is a vault to open rather than a copy target.
     *  [notes] is 0 when it holds only non-note files. */
    data class Occupied(val notes: Int, val lastModifiedMs: Long) : StorageDestination

    /** Cannot host a vault: not a directory, unreadable, or nested with the
     *  current notes folder. */
    data object Unusable : StorageDestination
}

/**
 * How a requested storage-location change is carried out.
 *
 * Changing location and moving notes are separate things. FUTO Notes copies the
 * vault only into a folder with nothing in it; a folder that already holds files
 * is opened as-is, because merging two populated vaults is never what the user
 * meant and deleting one is never ours to do.
 */
sealed interface StorageSwitchPlan {
    /** Copy the whole vault into the empty destination, journalled and verified. */
    data object Migrate : StorageSwitchPlan

    /** Point the app at the notes already there. Nothing is copied, merged, or
     *  deleted, so the current folder keeps every note it has — which is why the
     *  user has to be shown both sides before this runs. */
    data class OpenExisting(val notes: Int, val lastModifiedMs: Long) : StorageSwitchPlan

    data class Refuse(val message: String) : StorageSwitchPlan
}

/** Also shown when the confirmed switch re-checks sync before relaunching. */
const val SYNC_CONNECTED_STORAGE_REFUSAL =
    "Disconnect sync before switching to a folder that already has notes."

/**
 * Opening a populated folder adopts whatever sync state that folder carries
 * (`.e2ee-state.json` lives in the vault root), so a live session would reconcile
 * a different note set against the current watermark and park every drifted note
 * as a conflict copy. A migration carries that state along and is unaffected.
 */
fun storageSwitchPlan(
    destination: StorageDestination,
    isSyncConnected: Boolean,
): StorageSwitchPlan =
    when (destination) {
        StorageDestination.Unusable ->
            StorageSwitchPlan.Refuse(
                "That notes folder can't be used. Check that nothing else is using that path.",
            )
        StorageDestination.Empty -> StorageSwitchPlan.Migrate
        is StorageDestination.Occupied ->
            if (isSyncConnected) {
                StorageSwitchPlan.Refuse(SYNC_CONNECTED_STORAGE_REFUSAL)
            } else {
                StorageSwitchPlan.OpenExisting(destination.notes, destination.lastModifiedMs)
            }
    }

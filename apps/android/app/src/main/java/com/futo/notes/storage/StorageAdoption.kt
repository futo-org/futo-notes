package com.futo.notes.storage

internal sealed interface StorageAdoptionOutcome {
    /** The preference now names the adopted folder; relaunch onto it. */
    data object Restart : StorageAdoptionOutcome

    /** Nothing was re-pointed; stay on the current folder and say why. */
    data class KeepCurrent(val feedback: String) : StorageAdoptionOutcome
}

/**
 * Re-point the app at the notes already in a folder, in the one order that
 * cannot silently revert.
 *
 * Nothing is copied, merged, or deleted, so this is only ever reached after the
 * user has been shown both folders. Every step that can fail keeps the current
 * folder instead of relaunching, because a relaunch is what would hide the
 * failure: the shell rebuilds from the preference and looks like it worked.
 */
internal suspend fun adoptExistingVault(
    mode: StorageMode,
    isSyncConnected: suspend () -> Boolean,
    flushDrafts: suspend () -> Boolean,
    clearJournal: suspend () -> Boolean,
    commitPreference: suspend (StorageMode) -> Boolean,
): StorageAdoptionOutcome {
    // Sync could have connected while the confirmation dialog was up, and
    // opening a folder adopts whatever checkpoint that folder carries.
    if (isSyncConnected()) return StorageAdoptionOutcome.KeepCurrent(SYNC_CONNECTED_STORAGE_REFUSAL)

    if (!flushDrafts()) {
        return StorageAdoptionOutcome.KeepCurrent(
            "Your notes could not be saved first, so the folder was not changed."
        )
    }

    // Retire any migration record BEFORE re-pointing the preference. The journal
    // outranks the preference at startup, and a completed Device migration
    // deliberately leaves an ACTIVATED record on disk while its retained source
    // awaits cleanup — so a surviving record would name the old destination as
    // the verified root and silently revert this choice on the very next launch.
    // Nothing is lost by clearing it: adopting a different folder is what makes
    // that pending cleanup moot.
    if (!clearJournal()) {
        return StorageAdoptionOutcome.KeepCurrent(
            "The previous move could not be closed out, so the folder was not changed."
        )
    }

    // Unlike [activateStagedStorageMigration], the commit result is load-bearing
    // here. There, a false commit still relaunches onto the new root because the
    // ACTIVATED journal record survives and outranks the preference. This path
    // just retired that record, so the preference is the only thing carrying the
    // user's choice: restarting on a failed commit would relaunch on the OLD
    // folder with nothing left to correct it — the exact silent revert this
    // switch exists to stop.
    if (!commitPreference(mode)) {
        return StorageAdoptionOutcome.KeepCurrent(
            "That folder could not be saved as the notes location, so it was not changed."
        )
    }

    return StorageAdoptionOutcome.Restart
}

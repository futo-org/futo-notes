package com.futo.notes.storage

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Opening an already-populated folder retires the migration journal before it
 * re-points the preference, which leaves the preference as the ONLY record of
 * the user's choice. Every step that can fail therefore has to keep the current
 * folder rather than relaunch: a relaunch rebuilds the shell from the preference
 * and looks identical to success, which is how a failed switch reads as a
 * spontaneous revert to the old folder.
 */
class StorageAdoptionTest {
    private class Recorder {
        val steps = mutableListOf<String>()
        var syncConnected = false
        var flushSucceeds = true
        var journalClearSucceeds = true
        var commitSucceeds = true
        var committedMode: StorageMode? = null

        suspend fun run(mode: StorageMode = StorageMode.DEVICE): StorageAdoptionOutcome =
            adoptExistingVault(
                mode = mode,
                isSyncConnected = { steps += "sync"; syncConnected },
                flushDrafts = { steps += "flush"; flushSucceeds },
                clearJournal = { steps += "journal"; journalClearSucceeds },
                commitPreference = { requested ->
                    steps += "commit"
                    committedMode = requested
                    commitSucceeds
                },
            )
    }

    @Test
    fun aClearRunCommitsTheModeAndRestarts() = runBlocking {
        val recorder = Recorder()

        val outcome = recorder.run(StorageMode.DEVICE)

        assertEquals(StorageAdoptionOutcome.Restart, outcome)
        assertEquals(StorageMode.DEVICE, recorder.committedMode)
        assertEquals(listOf("sync", "flush", "journal", "commit"), recorder.steps)
    }

    /**
     * The blocker this test exists for: the preference commit result was ignored
     * and the app restarted anyway, so a failed commit relaunched on the OLD
     * folder — with the journal already retired, nothing was left to correct it.
     */
    @Test
    fun aFailedPreferenceCommitKeepsTheCurrentFolderInsteadOfRestarting() = runBlocking {
        val recorder = Recorder().apply { commitSucceeds = false }

        val outcome = recorder.run()

        assertEquals(
            StorageAdoptionOutcome.KeepCurrent(StorageAdoptionFailure.PREFERENCE_SAVE_FAILED),
            outcome,
        )
    }

    @Test
    fun aFailedJournalRetirementStopsBeforeTouchingThePreference() = runBlocking {
        val recorder = Recorder().apply { journalClearSucceeds = false }

        val outcome = recorder.run()

        assertEquals(
            StorageAdoptionOutcome.KeepCurrent(StorageAdoptionFailure.JOURNAL_CLEAR_FAILED),
            outcome,
        )
        assertEquals(listOf("sync", "flush", "journal"), recorder.steps)
    }

    /** Drafts are flushed before anything is retired, so a failed flush costs nothing. */
    @Test
    fun anUnflushableDraftStopsBeforeTheJournalIsRetired() = runBlocking {
        val recorder = Recorder().apply { flushSucceeds = false }

        val outcome = recorder.run()

        assertEquals(
            StorageAdoptionOutcome.KeepCurrent(StorageAdoptionFailure.DRAFT_FLUSH_FAILED),
            outcome,
        )
        assertEquals(listOf("sync", "flush"), recorder.steps)
    }

    /**
     * Sync is re-checked here, not only when the plan was made: it can connect
     * while the confirmation dialog is up, and opening a folder adopts whatever
     * sync checkpoint that folder carries.
     */
    @Test
    fun syncConnectingDuringTheConfirmationRefusesBeforeAnythingIsTouched() = runBlocking {
        val recorder = Recorder().apply { syncConnected = true }

        val outcome = recorder.run()

        assertEquals(
            StorageAdoptionOutcome.KeepCurrent(StorageAdoptionFailure.SYNC_CONNECTED),
            outcome,
        )
        assertEquals(listOf("sync"), recorder.steps)
    }
}

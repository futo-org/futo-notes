package com.futo.notes

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeEditorDraftCheckpointTest {
    @Test fun checkpointsEveryNativeSessionBeforeHandoff() = runBlocking {
        val saved = mutableListOf<String>()
        val drafts = listOf(
            NativeEditorDraft({ saved += "first"; true }, { "first" }),
            NativeEditorDraft({ saved += "second"; true }, { "second" }),
        )
        assertTrue(checkpointNativeDrafts(drafts))
        assertEquals(listOf("first", "second"), saved)
    }

    @Test fun aFailedCheckpointRefusesHandoffAndStillAttemptsOtherSessions() = runBlocking {
        val saved = mutableListOf<String>()
        val drafts = listOf(
            NativeEditorDraft({ saved += "first"; false }, { "first" }),
            NativeEditorDraft({ saved += "second"; true }, { "second" }),
        )
        assertFalse(checkpointNativeDrafts(drafts))
        assertEquals(listOf("first", "second"), saved)
    }

    @Test fun migrationUsesTheCallbackForAnAlreadyHeldGate() = runBlocking {
        var protectedCalls = 0
        var migrationCalls = 0
        val draft = NativeEditorDraft(
            checkpoint = { protectedCalls += 1; true },
            unsavedNoteId = { null },
            checkpointForMigration = { migrationCalls += 1; true },
        )
        assertTrue(checkpointNativeDrafts(listOf(draft)))
        assertEquals(1, protectedCalls)
        assertEquals(0, migrationCalls)
        assertTrue(checkpointNativeDrafts(listOf(draft), forMigration = true))
        assertEquals(1, protectedCalls)
        assertEquals(1, migrationCalls)
    }

    @Test fun succeedsWithoutAnOpenNativeEditor() = runBlocking {
        assertTrue(checkpointNativeDrafts(emptyList()))
    }
}

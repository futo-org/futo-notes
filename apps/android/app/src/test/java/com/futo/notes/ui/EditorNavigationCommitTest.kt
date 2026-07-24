package com.futo.notes.ui

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import uniffi.futo_notes_ffi.FlushDisposition

class EditorNavigationCommitTest {
    @Test
    fun `pending navigation disables editor interaction`() {
        assertTrue(isEditorInteractionEnabled(navigationPending = false))
        assertFalse(isEditorInteractionEnabled(navigationPending = true))
    }

    @Test
    fun `pending navigation consumes back without starting a second navigation`() {
        assertTrue(shouldStartEditorBackNavigation(navigationPending = false))
        assertFalse(shouldStartEditorBackNavigation(navigationPending = true))
    }

    @Test
    fun `navigation commits a valid title without waiting for the debounce`() = runBlocking {
        var renamed: Pair<String, String>? = null

        val finalId = commitEditorTitleSnapshot(
            currentId = "Folder/Old title",
            targetId = "Folder/New title",
        ) { oldId, targetId ->
            renamed = oldId to targetId
            targetId
        }

        assertEquals("Folder/New title", finalId)
        assertEquals("Folder/Old title" to "Folder/New title", renamed)
    }

    @Test
    fun `navigation admission rejects a second request until failure permits retry`() {
        val admission = EditorNavigationAdmission()

        assertTrue(admission.tryBegin())
        assertFalse(admission.tryBegin())

        admission.retryAfterFailure()
        assertTrue(admission.tryBegin())
    }

    @Test
    fun `clean editor navigates without writing`() = runBlocking {
        var writes = 0

        val result = commitEditorNavigationSnapshot("saved", "saved") { _, _ ->
            writes += 1
            FlushDisposition.Wrote
        }

        assertEquals(0, writes)
        assertEquals("saved", result.savedContent)
        assertTrue(result.canNavigate)
    }

    @Test
    fun `successful dirty snapshot advances saved content and permits navigation`() = runBlocking {
        val result = commitEditorNavigationSnapshot("base", "dirty") { base, snapshot ->
            assertEquals("base", base)
            assertEquals("dirty", snapshot)
            FlushDisposition.Wrote
        }

        assertEquals("dirty", result.savedContent)
        assertTrue(result.canNavigate)
    }

    @Test
    fun `failed dirty snapshot remains dirty and blocks navigation`() = runBlocking {
        val result = commitEditorNavigationSnapshot("base", "dirty") { _, _ ->
            null
        }

        assertEquals("base", result.savedContent)
        assertFalse(result.canNavigate)
    }

    @Test
    fun `parked conflict preserves the draft and permits navigation`() = runBlocking {
        val result = commitEditorNavigationSnapshot("base", "dirty") { _, _ ->
            FlushDisposition.ParkedConflict("note (conflict)")
        }

        assertEquals("dirty", result.savedContent)
        assertTrue(result.canNavigate)
    }
}

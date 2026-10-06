package com.futo.notes.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EditorRenameHandoverTest {
    @Test
    fun `the re-key after a rename continues the open note`() {
        val handover = EditorRenameHandover()
        handover.begin("new title")

        assertTrue(handover.pending)
        assertTrue(handover.consume("new title"))
        assertFalse(handover.pending)
    }

    @Test
    fun `a continuation is consumed once`() {
        val handover = EditorRenameHandover()
        handover.begin("new title")
        handover.consume("new title")

        assertFalse(handover.consume("new title"))
    }

    @Test
    fun `opening a different note is a fresh open and ends the handover`() {
        val handover = EditorRenameHandover()
        handover.begin("new title")

        assertFalse(handover.consume("other note"))
        assertFalse(handover.pending)
        assertFalse(handover.consume("new title"))
    }

    @Test
    fun `an attach with no rename is a fresh open`() {
        assertFalse(EditorRenameHandover().consume("any"))
    }
}

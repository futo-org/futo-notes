package com.futo.notes.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EditorAttachmentGateTest {
    @Test
    fun `new note attachment rejects work captured by the previous note`() {
        val gate = EditorAttachmentGate()
        val firstNote = gate.attach()

        val secondNote = gate.attach()

        assertFalse(gate.permits(firstNote))
        assertTrue(gate.permits(secondNote))
    }

    @Test
    fun `detaching invalidates work even before another note attaches`() {
        val gate = EditorAttachmentGate()
        val note = gate.attach()

        gate.detach(note)

        assertFalse(gate.permits(note))
        assertNull(gate.current())
    }

    @Test
    fun `stale detach cannot invalidate the current note`() {
        val gate = EditorAttachmentGate()
        val firstNote = gate.attach()
        val secondNote = gate.attach()

        gate.detach(firstNote)

        assertTrue(gate.permits(secondNote))
    }

    @Test
    fun `cancelled insertion permit rejects posted work while note remains attached`() {
        val gate = EditorAttachmentGate()
        val note = gate.attach()
        val insertion = EditorAttachmentOperationPermit(gate, note)

        insertion.cancel()

        assertFalse(insertion.mayRun())
        assertTrue(gate.permits(note))
    }
}

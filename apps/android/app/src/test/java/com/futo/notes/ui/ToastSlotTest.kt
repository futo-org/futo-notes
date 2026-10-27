package com.futo.notes.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class ToastSlotTest {
    private val cancelled = mutableListOf<String>()
    private val slot = ToastSlot<String> { cancelled += it }

    @Test
    fun `a second toast cancels the first and takes the slot`() {
        slot.show("first", "Note deleted")
        slot.show("second", "Moved to Work")
        assertEquals(listOf("first"), cancelled)
        assertEquals("Moved to Work", slot.message)
    }

    @Test
    fun `the cancelled toast reporting hidden late leaves its successor`() {
        slot.show("first", "Note deleted")
        slot.show("second", "Moved to Work")
        slot.hidden("first")
        assertEquals("Moved to Work", slot.message)
        slot.hidden("second")
        assertEquals("", slot.message)
    }
}

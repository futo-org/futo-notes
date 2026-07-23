package com.futo.notes.ui

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class EditorMutationGateTest {
    @Test
    fun `queued editor save is rejected after destructive action begins`() = runBlocking {
        val gate = EditorMutationGate()
        var wrote = false

        gate.beginDestructiveAction()
        val result = gate.runEditorMutation {
            wrote = true
            "written"
        }

        assertNull(result)
        assertFalse(wrote)
    }
}

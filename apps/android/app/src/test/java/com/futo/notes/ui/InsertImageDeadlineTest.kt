package com.futo.notes.ui

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InsertImageDeadlineTest {
    @Test
    fun `an insert that answers within the deadline is the answer`() = runBlocking {
        val result = insertImageWithinDeadline(deadlineMs = 5_000) { true }
        assertTrue(result)
    }

    @Test
    fun `a host that never answers fails cleanly instead of hanging forever`() = runBlocking {
        // The dead-renderer case: `evaluateJavascript`'s callback never fires,
        // so the coroutine this stands in for would otherwise suspend forever.
        val result = insertImageWithinDeadline(deadlineMs = 20) {
            delay(10_000)
            true
        }
        assertFalse(result)
    }
}

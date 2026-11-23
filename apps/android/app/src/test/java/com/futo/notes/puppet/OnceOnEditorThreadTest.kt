package com.futo.notes.puppet

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/** A puppet edit that times out never runs later; one that started is waited for to its end. */
class OnceOnEditorThreadTest {
    @Test
    fun workQueuedPastTheTimeoutNeverRuns() = runBlocking {
        var queued: Runnable? = null
        var ran = false
        val answer = onceOnEditorThread({ queued = it; true }, timeoutMs = 50) { ran = true; "moved" }
        assertNull("the caller is told nothing was done", answer)
        // The busy editor thread finally reaches it: it must not edit the note now.
        queued!!.run()
        assertFalse(ran)
    }

    @Test
    fun workThatStartedBeforeTheTimeoutIsAnsweredEvenWhenItEndsAfter() = runBlocking {
        val answer = onceOnEditorThread({ Thread(it).start(); true }, timeoutMs = 50) { Thread.sleep(300); "moved" }
        assertEquals("moved", answer)
    }

    @Test
    fun aThreadThatTakesNothingAnswersNull() = runBlocking {
        assertNull(onceOnEditorThread({ false }, timeoutMs = 50) { "moved" })
    }
}

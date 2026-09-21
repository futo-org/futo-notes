package com.futo.notes.ui

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * F3: `EditorWebView.insertImageAndWait` used to await `evaluateJavascript`
 * with NO deadline while holding `EditorSession.runWork`'s mutex — the exact
 * lock a NAVIGATE exit's `awaitPendingWork()` waits on. A renderer wedged in
 * a long parse delayed Back for the parse; a renderer that never answers at
 * all (a torn-down WebView) left Back, the toolbar, and every text field dead
 * until process death.
 *
 * [insertImageWithinDeadline] is the extracted seam: the timeout behavior is
 * assertable without a real WebView, the same reason
 * [EditorCaptureDeadlineTest] tests [captureWithinDeadline] this way.
 */
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

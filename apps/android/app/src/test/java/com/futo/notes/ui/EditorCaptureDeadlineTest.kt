package com.futo.notes.ui

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What running out of time MEANS, and why one answer could not carry both cases.
 *
 * The Milkdown editor mounts a large note's FIRST CHUNK synchronously and
 * streams the rest in idle slices, so `initialized` — and with it the shell's
 * `isReady` — arrives while the tail is still landing. The user can type into
 * that first viewport, and while the load is in flight the editor deliberately
 * withholds its `change` notification (a streaming document is a PREFIX of the
 * note, so reporting it would save a truncated file). The shell's own copy
 * therefore does NOT contain that edit. A capture in that window asks for the
 * whole document, which makes the editor finish the remaining parse
 * synchronously; on a big enough note that costs more than the deadline, and
 * reading the deadline as "no live document" let the exit leave on the stale
 * copy and the edit was gone.
 *
 * The deadline could not simply start refusing instead. It was added for a
 * 50,000-line single paragraph whose parse blocks the renderer's JS thread for
 * MINUTES (commit c3ae95cc), and `isReady` does not protect that case: it is
 * app-lifetime state on the pre-warmed WebView, set on the first `initialized`
 * and cleared only by renderer death, so it is already true when the next note's
 * `setContent` wedges the thread. Refusing there is the trap that commit fixed —
 * Back dead, every tap a toast, force-quit the only way off the screen.
 *
 * So the two are told apart by a trivial round trip dispatched BEFORE the
 * capture: a streaming editor answers it between idle slices, a wedged one never
 * runs it.
 */
class EditorCaptureDeadlineTest {
    private fun neverAnswers(): suspend () -> EditorCaptureOutcome = {
        delay(10_000)
        EditorCaptureOutcome.Captured("unreachable")
    }

    @Test
    fun `an answer inside the deadline is the answer`() = runBlocking {
        val outcome = captureWithinDeadline(
            deadlineMs = 5_000,
            startLivenessProbe = {},
            rendererAnswered = { false },
        ) { EditorCaptureOutcome.Captured("live") }
        assertEquals(EditorCaptureOutcome.Captured("live"), outcome)
    }

    @Test
    fun `a busy but answering renderer times out instead of claiming no document`() = runBlocking {
        // The editor is finishing the streamed tail, so the capture cannot
        // answer — but the renderer is turning over and the probe came back.
        val outcome = captureWithinDeadline(
            deadlineMs = 20,
            startLivenessProbe = {},
            rendererAnswered = { true },
            capture = neverAnswers(),
        )
        assertEquals(EditorCaptureOutcome.TimedOut, outcome)
    }

    @Test
    fun `a wedged renderer is still NoLiveDocument, so the user can leave`() = runBlocking {
        // The 50,000-line single paragraph: one long synchronous parse, so
        // neither the capture nor the probe ever runs.
        val outcome = captureWithinDeadline(
            deadlineMs = 20,
            startLivenessProbe = {},
            rendererAnswered = { false },
            capture = neverAnswers(),
        )
        assertEquals(EditorCaptureOutcome.NoLiveDocument, outcome)
    }

    @Test
    fun `the liveness probe is dispatched before the capture runs`() = runBlocking {
        // The ordering IS the mechanism: behind the capture in the renderer's
        // task queue, the probe would wait on the very parse it is meant to
        // report around, and every timeout would read as a wedge again.
        var probed = false
        var probedBeforeCapture = false
        captureWithinDeadline(
            deadlineMs = 20,
            startLivenessProbe = { probed = true },
            rendererAnswered = { false },
        ) {
            probedBeforeCapture = probed
            EditorCaptureOutcome.Captured("live")
        }
        assertTrue(probedBeforeCapture)
    }

    @Test
    fun `liveness is only consulted when the deadline actually expires`() = runBlocking {
        // A capture that answered needs no adjudication, and asking anyway would
        // read a probe result that may simply not have landed yet.
        var asked = false
        captureWithinDeadline(
            deadlineMs = 5_000,
            startLivenessProbe = {},
            rendererAnswered = {
                asked = true
                true
            },
        ) { EditorCaptureOutcome.Captured("live") }
        assertEquals(false, asked)
    }

    @Test
    fun `a timed-out capture refuses the exit instead of committing the stale copy`() {
        // The user typed into the first viewport while the tail streamed, so the
        // shell never saw the edit. Leaving on `shellCopy` discards it.
        assertNull(editorExitBody(EditorCaptureOutcome.TimedOut, shellCopy = "the note as opened"))
    }

    @Test
    fun `an editor that never presented a document still lets the user leave`() {
        assertEquals(
            "from disk",
            editorExitBody(EditorCaptureOutcome.NoLiveDocument, shellCopy = "from disk"),
        )
    }
}

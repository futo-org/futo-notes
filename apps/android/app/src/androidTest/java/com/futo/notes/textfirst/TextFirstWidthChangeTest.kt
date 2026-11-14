package com.futo.notes.textfirst

import android.os.Looper
import android.os.SystemClock
import android.widget.FrameLayout
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import uniffi.futo_notes_ffi.EditorInlineFormat

/**
 * A new width (rotation, split screen, a fold) re-lays out every line the
 * view holds, on the main thread. On a fully streamed huge note that froze
 * the app for seconds (an ANR on the Pixel). The main thread stays under the
 * ANR bar and the reader keeps the caret, selection, place and edits.
 */
class TextFirstWidthChangeTest {
    /** The shape of the reported note, at a quarter of its size: still seconds of whole-note layout. */
    private val huge = buildString { for (i in 1..10_000) append("## Section $i\n\nBody line $i with some **bold** text.\n\n") }

    /** The longest single main-thread message while [block] runs, the way an ANR or a dropped frame sees it. */
    private fun StreamingRig.longestMainThreadMessage(block: () -> Unit): Long {
        val longest = AtomicLong(0)
        var began = 0L
        ui {
            Looper.getMainLooper().setMessageLogging { line ->
                if (line.startsWith(">>>>>")) began = SystemClock.uptimeMillis()
                else if (line.startsWith("<<<<<") && began > 0) {
                    val took = SystemClock.uptimeMillis() - began
                    if (took >= 50) android.util.Log.w("WidthChangeTest", "main thread message took $took ms: $line")
                    longest.set(maxOf(longest.get(), took))
                }
            }
        }
        try { block() } finally { ui { Looper.getMainLooper().setMessageLogging(null) } }
        return longest.get()
    }

    private fun StreamingRig.setWidth(width: Int) = ui {
        controller.view.layoutParams = FrameLayout.LayoutParams(width, FrameLayout.LayoutParams.MATCH_PARENT)
    }

    /** Until the view holds the whole note again and has put the reader back. */
    private fun StreamingRig.awaitSettled() = runBlocking {
        withTimeout(120_000) {
            while (true) {
                var settled = false
                ui { settled = controller.view.contentComplete && controller.view.restoring == null }
                if (settled) break
                delay(20)
            }
        }
    }

    @Test fun aWidthChangeOnAStreamedHugeNoteStaysUnderTheAnrBarAndKeepsThePlace() = streamingExercise(huge) {
        engine.handler.post { engine.streamTail(0) }
        awaitSettled()
        val display = display()
        // An unsaved edit, then a selection and a reading position well past the first screens.
        val edited = display.indexOf("Body line 5000 ")
        engine.handler.post { engine.select(edited, edited, false); engine.imeCommit("EDITED ") }
        val selStart = display.indexOf("Body line 7000 ") + "EDITED ".length
        engine.handler.post { engine.select(selStart, selStart + 4, false) }
        barrier()
        var anchor: ScrollAnchor? = null
        val anchorAt = display.indexOf("Section 6000\n") + "EDITED ".length
        ui {
            val v = controller.view
            v.scrollTo(0, v.anchorY(ScrollAnchor(anchorAt, 0))!!)
            anchor = v.scrollAnchor()
        }
        assertEquals(anchorAt, anchor!!.offset)
        var width = 0
        ui { width = controller.view.width }

        for (next in listOf(width * 3 / 5, width)) {
            val longest = longestMainThreadMessage {
                setWidth(next)
                barrier()
                awaitSettled()
            }
            assertTrue("main thread blocked $longest ms on a width change to $next", longest < 100)
            val now = display()
            ui {
                val v = controller.view
                assertEquals(next, v.width)
                assertEquals("the reader's line stays at the top", anchor!!.offset, v.scrollAnchor()!!.offset)
                assertEquals(selStart, v.selectionStart)
                assertEquals(selStart + 4, v.selectionEnd)
                assertEquals(now + TextFirstEditText.END_SENTINEL, v.text.toString())
            }
            barrier()
            assertEquals(selStart, engine.selStart)
            assertEquals(selStart + 4, engine.selEnd)
        }
        assertTrue("the unsaved edit survives", source().contains("EDITED Body line 5000 "))
    }

    /** TextView drops its whole layout on any configuration change (a rotation, dark mode) to re-read the default locale. */
    @Test fun aConfigurationChangeAtTheSameWidthDoesNotLayOutTheNoteAgain() = streamingExercise(huge) {
        engine.handler.post { engine.streamTail(0) }
        awaitSettled()
        val longest = longestMainThreadMessage {
            ui {
                val v = controller.view
                val config = android.content.res.Configuration(v.resources.configuration)
                config.uiMode = config.uiMode xor android.content.res.Configuration.UI_MODE_NIGHT_MASK
                v.dispatchConfigurationChanged(config)
                v.requestLayout()
            }
            runBlocking { withTimeout(10_000) { while (true) { var pending = true; ui { pending = controller.view.isLayoutRequested }; if (!pending) break; delay(10) } } }
        }
        assertTrue("main thread blocked $longest ms on a configuration change", longest < 100)
        val display = display()
        ui { assertEquals("nothing to stream again", display + TextFirstEditText.END_SENTINEL, controller.view.text.toString()) }
    }

    @Test fun aWidthChangeWhileStreamingOrFormattingStillEndsWithTheWholeNote() = streamingExercise(huge) {
        var width = 0
        ui { width = controller.view.width }
        val longest = longestMainThreadMessage {
            engine.handler.post { engine.streamTail(0) }
            runBlocking { withTimeout(60_000) { while (true) { var n = 0; ui { n = controller.view.length() }; if (n > 60_000) break; delay(5) } } }
            setWidth(width * 3 / 5)
            barrier()
            // A whole-note command is running on the editor thread while the width changes back.
            engine.selectAll()
            engine.toggleFormat(EditorInlineFormat.BOLD)
            setWidth(width)
            barrier()
            awaitSettled()
        }
        // Whole-note Bold renders in bounded slices whose applies, with the
        // whole note selected, reach ~150 ms on a loaded shared emulator; a
        // whole-note relayout of this note takes over 1 s.
        assertTrue("main thread blocked $longest ms", longest < 250)
        val display = display()
        assertTrue("the whole note was made bold", source().contains("**Body line 9999 with some "))
        ui { assertEquals(display + TextFirstEditText.END_SENTINEL, controller.view.text.toString()) }
    }
}

package com.futo.notes.textfirst

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import uniffi.futo_notes_ffi.EditorBlockCommand
import uniffi.futo_notes_ffi.EditorInlineFormat
import uniffi.futo_notes_ffi.FlushDraftResult

/** Ordered logical commands stay correct while the view renders bounded, acknowledged work. */
class TextFirstStreamingCommandsTest {
    @Test fun selectAllKeepsAppendingBoundedSlicesWithUiWorkBetweenThem() = exercise {
        val trace = trace()
        engine.selectAll()
        barrier()
        awaitComplete()
        ui {
            assertTrue("Select All uses multiple bounded applies", trace.appendSizes.size > 1)
            assertTrue("no all-tail flush: ${trace.appendSizes.maxOrNull()}", trace.appendSizes.all { it <= OpenSlices.NEXT_CHARS * 2 })
            assertTrue("UI work ran between tail slices", trace.interleaved)
            assertEquals(0, controller.view.selectionStart)
            assertEquals(controller.view.length() - 1, controller.view.selectionEnd)
        }
        assertEquals(original, source())
    }

    @Test fun selectAllThenImmediateImeReplacesTheLogicalWholeNoteWithoutResurrectingOldTail() = exercise {
        val trace = trace()
        engine.selectAll()
        engine.handler.post { engine.imeCommit("x") }
        barrier()
        awaitComplete()
        runBlocking { controller.checkpoint() }
        assertEquals("x\n", store.read("n"))
        val display = display()
        ui {
            assertEquals(display + TextFirstEditText.END_SENTINEL, controller.view.text.toString())
            assertTrue("IME must not force the old tail into one apply", trace.appendSizes.all { it <= OpenSlices.NEXT_CHARS * 2 })
        }
    }

    @Test fun selectAllBoldThenImmediateImeKeepsCanonicalOperationOrder() = exercise {
        engine.selectAll()
        engine.toggleFormat(EditorInlineFormat.BOLD)
        engine.handler.post { engine.imeCommit("x") }
        barrier()
        awaitComplete()
        runBlocking { controller.checkpoint() }
        assertEquals("**x**\n", store.read("n"))
        val display = display()
        ui { assertEquals(display + TextFirstEditText.END_SENTINEL, controller.view.text.toString()) }
    }

    @Test fun wholeNoteStyleChangesOnAFullyShownNoteKeepViewportAndYieldBetweenBoundedApplies() = exercise {
        engine.handler.post { engine.streamTail(0) }
        awaitComplete()
        ui { controller.view.scrollTo(0, 300) }
        val trace = trace()
        engine.selectAll()
        engine.blockCommand(EditorBlockCommand.Quote)
        barrier()
        awaitComplete()
        ui {
            assertTrue("whole-note restyle uses multiple applies", trace.windowSizes.size > 1)
            assertTrue("no full-window restyle: ${trace.windowSizes.maxOrNull()}", trace.windowSizes.all { it <= OpenSlices.NEXT_CHARS * 2 })
            assertTrue("UI work ran between restyle slices", trace.interleaved)
            assertEquals("style-only formatting preserves the reader's viewport", 300, controller.view.scrollY)
        }
        assertTrue(source().startsWith("> paragraph 0"))
    }

    @Test fun leavingCancelsQueuedFormattingButKeepsInputAfterLogicalSelectAll() = exercise {
        val trace = trace()
        val blocked = CountDownLatch(1)
        val resume = CountDownLatch(1)
        engine.handler.post { engine.handler.removeCallbacks(engine.tailRunnable); blocked.countDown(); check(resume.await(10, TimeUnit.SECONDS)) }
        assertTrue(blocked.await(10, TimeUnit.SECONDS))
        val closed = CompletableDeferred<FlushDraftResult?>()
        try {
            engine.selectAll()
            engine.toggleFormat(EditorInlineFormat.BOLD)
            engine.handler.post { engine.imeCommit("x") }
            ui {
                CoroutineScope(Dispatchers.Main.immediate).launch(start = CoroutineStart.UNDISPATCHED) {
                    closed.complete(controller.close())
                }
            }
        } finally { resume.countDown() }
        assertNotNull(runBlocking { withTimeout(10_000) { closed.await() } })
        assertEquals("x\n", store.read("n"))
        ui { assertTrue(trace.appendSizes.all { it <= OpenSlices.NEXT_CHARS * 2 }) }
    }

    @Test fun lengthChangingCompositionPausesFreshTailQueriesUntilItCommits() = exercise {
        engine.handler.post { engine.handler.removeCallbacks(engine.tailRunnable) }
        barrier()
        val trace = trace()
        engine.handler.post {
            check(engine.streaming) { "fixture must still have an unshown tail" }
            engine.imeSetComposing("marked")
            engine.showNextSlice()
            engine.imeSetComposing("a longer marked word")
            engine.showNextSlice()
        }
        barrier()
        ui { assertTrue("marked offsets cannot be used to project committed tail coordinates", trace.appendSizes.isEmpty()) }
        engine.handler.post { engine.imeFinishComposing() }
        barrier()
        awaitComplete()
        val display = display()
        ui { assertEquals(display + TextFirstEditText.END_SENTINEL, controller.view.text.toString()) }
        assertTrue(source().startsWith("a longer marked wordparagraph 0"))
    }

    @Test fun selectAllThenLengthChangingImeCompositionKeepsTheLogicalReplacement() = exercise {
        engine.selectAll()
        engine.handler.post {
            engine.imeSetComposing("a longer marked replacement")
            engine.imeSetComposing("x")
            engine.imeFinishComposing()
        }
        barrier()
        awaitComplete()
        runBlocking { controller.checkpoint() }
        assertEquals("x\n", store.read("n"))
        val display = display()
        ui { assertEquals(display + TextFirstEditText.END_SENTINEL, controller.view.text.toString()) }
    }

    @Test fun committingOriginalTextAfterWholeNoteCompositionRestoresItInBoundedSlices() = exercise {
        val before = original
        val trace = trace()
        engine.selectAll()
        engine.handler.post { engine.imeSetComposing("x"); engine.imeCommit(before) }
        barrier()
        awaitComplete()
        assertEquals(before, source())
        val display = display()
        ui {
            assertEquals(display + TextFirstEditText.END_SENTINEL, controller.view.text.toString())
            assertTrue(trace.appendSizes.all { it <= OpenSlices.NEXT_CHARS * 2 })
        }
    }

    @Test fun pendingWholeNoteStylesFollowALaterNativeCaretAndCommittedPrefixInsertion() = exercise {
        engine.handler.post { engine.streamTail(0) }
        awaitComplete()
        val inserted = "X".repeat(300)
        val accepted = CompletableDeferred<Unit>()
        var injected = false
        ui {
            controller.view.onApplyMeasured = { _, update ->
                if (update.styleOnly && !injected) {
                    injected = true
                    // The native caret/IME request is posted before this slice's
                    // acknowledgement; remaining style coordinates must move.
                    controller.view.setSelection(0)
                    engine.handler.post { engine.imeCommit(inserted); accepted.complete(Unit) }
                }
            }
        }
        engine.selectAll()
        engine.blockCommand(EditorBlockCommand.Quote)
        runBlocking { withTimeout(20_000) { accepted.await() } }
        barrier()
        awaitComplete()
        val display = display()
        val at = display.lastIndexOf("paragraph 1999").also { assertTrue(it > 0) }
        ui {
            assertEquals(display + TextFirstEditText.END_SENTINEL, controller.view.text.toString())
            assertEquals(300, controller.view.selectionStart)
            assertEquals(300, controller.view.selectionEnd)
            assertTrue("the final row receives its shifted quote style", controller.view.editableText.getSpans(at, at + 1, TfQuote::class.java).any { it.depth == 1 })
        }
        assertTrue(source().startsWith("> ${inserted}paragraph 0"))
    }

    @Test fun aStyleSliceCannotPinTheViewportAgainstLaterBottomCaretTyping() = exercise {
        engine.handler.post { engine.streamTail(0) }
        awaitComplete()
        val entered = CompletableDeferred<Unit>()
        val drawn = CountDownLatch(1)
        var requested = Long.MAX_VALUE
        var overflow = 0
        var injected = false
        ui {
            controller.view.scrollTo(0, 300)
            controller.view.onFrameDrawn = { timings ->
                if (timings.input >= requested) {
                    val view = controller.view
                    val layout = view.layout
                    overflow = layout.getLineBottom(layout.getLineForOffset(view.selectionEnd)) + view.totalPaddingTop - view.scrollY - (view.height - view.extendedPaddingBottom)
                    drawn.countDown()
                }
            }
            controller.view.onApplyMeasured = { _, update ->
                if (update.styleOnly && !injected) {
                    injected = true
                    requested = android.os.SystemClock.elapsedRealtimeNanos()
                    engine.handler.post {
                        // Keyboard navigation echoes to the native view under
                        // applying=true; it must still outrank a style anchor.
                        engine.imeSetSelection(engine.text.length, engine.text.length)
                        engine.key(uniffi.futo_notes_ffi.EditorParagraphKey.ENTER)
                        entered.complete(Unit)
                    }
                }
            }
        }
        engine.selectAll()
        engine.blockCommand(EditorBlockCommand.Quote)
        runBlocking { withTimeout(20_000) { entered.await() } }
        assertTrue("the Enter frame was drawn", drawn.await(10, TimeUnit.SECONDS))
        assertTrue("style-only anchor must not leave the new caret $overflow px below the viewport", overflow <= 0)
    }

    @Test fun hugeMarkedTextUsesABoundedRawPrefixWithoutLosingTheImeValue() = exercise {
        val value = "X".repeat(20_000)
        var largestReset = 0
        var largestDelta = 0
        ui {
            controller.view.onApplyMeasured = { _, update ->
                largestReset = maxOf(largestReset, update.reset?.length ?: 0)
                if (update.reset == null) largestDelta = maxOf(largestDelta, update.edits.maxOfOrNull { it.text.length } ?: 0)
            }
        }
        engine.selectAll()
        engine.handler.post { engine.imeSetComposing(value) }
        barrier()
        assertEquals(value, display())
        ui {
            assertTrue(controller.view.length() - 1 <= OpenSlices.FIRST_CHARS)
            assertTrue(largestReset <= OpenSlices.FIRST_CHARS)
            assertTrue("marked payload must be a reset prefix rather than an unbounded visible edit", largestDelta <= OpenSlices.NEXT_CHARS * 2)
        }
        engine.handler.post { engine.imeFinishComposing() }
        barrier()
        awaitComplete()
        assertEquals(value, display())
        ui { assertEquals(value + TextFirstEditText.END_SENTINEL, controller.view.text.toString()) }
    }

    @Test fun anEmphasisCommitCrossingTheRolledBackPrefixUsesAnAuthoritativeReset() = exercise(
        "a".repeat(6_005) + "\n" + "b".repeat(20) + "**\n" + "tail\n".repeat(20_000),
    ) {
        engine.handler.post { engine.imeSetComposing("**" + "Z".repeat(98)); engine.imeFinishComposing() }
        barrier()
        awaitComplete()
        val display = display()
        ui { assertEquals(display + TextFirstEditText.END_SENTINEL, controller.view.text.toString()) }
        assertTrue(source().contains("Z".repeat(98)))
    }

    @Test fun aClippedSelectionEchoCannotChangeTheLogicalImeReplacement() = exercise {
        lateinit var connection: android.view.inputmethod.InputConnection
        ui { connection = controller.view.onCreateInputConnection(android.view.inputmethod.EditorInfo())!! }
        engine.selectAll()
        barrier()
        var clipped = 0L
        ui { clipped = controller.view.renderedSelection }
        engine.handler.post {
            connection.setSelection((clipped ushr 32).toInt(), clipped.toInt())
            connection.commitText("x", 1)
        }
        barrier()
        awaitComplete()
        runBlocking { controller.checkpoint() }
        assertEquals("x\n", store.read("n"))
    }

    @Test fun anImeRequestForANewCollapsedCaretRemainsValidDuringClippedSelection() = exercise {
        lateinit var connection: android.view.inputmethod.InputConnection
        ui { connection = controller.view.onCreateInputConnection(android.view.inputmethod.EditorInfo())!! }
        engine.selectAll()
        barrier()
        engine.handler.post { connection.setSelection(5, 5); connection.commitText("x", 1) }
        barrier()
        assertEquals(original.take(5) + "x" + original.drop(5), source())
    }

    @Test fun logicalAllOmitsOversizedKeyboardContextButRetainsCanonicalCopyAndImeCommit() = exercise {
        lateinit var connection: android.view.inputmethod.InputConnection
        engine.selectAll()
        barrier()
        ui {
            val info = android.view.inputmethod.EditorInfo()
            connection = controller.view.onCreateInputConnection(info)!!
            assertEquals(0, info.initialSelStart)
            assertEquals(original.length, info.initialSelEnd)
            assertNull(androidx.core.view.inputmethod.EditorInfoCompat.getInitialSelectedText(info, 0))
        }
        val copied = CompletableDeferred<String>()
        engine.copy(false) { copied.complete(it) }
        assertEquals(original, runBlocking { withTimeout(10_000) { copied.await() } })
        val done = CountDownLatch(1)
        engine.handler.post {
            assertNull(connection.getSelectedText(0))
            assertNull(connection.getExtractedText(null, 0))
            if (android.os.Build.VERSION.SDK_INT >= 31) assertNull(connection.getSurroundingText(100, 100, 0))
            connection.commitText("x", 1)
            done.countDown()
        }
        assertTrue(done.await(10, TimeUnit.SECONDS))
        barrier()
        awaitComplete()
        assertEquals("x", source())
        runBlocking { controller.checkpoint() }
        assertEquals("x\n", store.read("n"))
    }

    @Test fun publishedKeyboardSnapshotKeepsGlobalSelectionAndMarkedCoordinates() = exercise {
        engine.handler.post { engine.select(12_000, 12_003, false); engine.imeSetComposing("marked") }
        barrier()
        ui {
            val state = engine.publishedIme!!
            assertEquals(12_000, state.composingStart)
            assertEquals(12_006, state.composingEnd)
            val info = android.view.inputmethod.EditorInfo()
            assertNotNull(controller.view.onCreateInputConnection(info))
            assertEquals(state.selectionStart, info.initialSelStart)
            assertEquals(state.selectionEnd, info.initialSelEnd)
            assertTrue(state.context!!.text.length <= IME_CONTEXT_CHARS + IME_SELECTED_CHARS)
        }
    }

    private fun exercise(body: String? = null, check: StreamingRig.() -> Unit) = streamingExercise(body, check)
}

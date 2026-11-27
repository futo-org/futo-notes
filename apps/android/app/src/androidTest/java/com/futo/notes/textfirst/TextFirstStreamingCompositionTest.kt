package com.futo.notes.textfirst

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

/** The keyboard's marked text while a long note's tail is still to come: the view only ever holds what it was given. */
class TextFirstStreamingCompositionTest {
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
        assertEquals("x", store.read("n"))
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

    /**
     * A keyboard's correction of a word the view has not been given yet (a caret the engine put in the unshown tail, as
     * Undo, a paste or Select All can), taken back to the word it was: the engine changes nothing, and the word's text
     * lands in the tail, not past the end of the view (crash #1874, "Renderer footprint outside the Editable").
     */
    @Test fun aCorrectionTakenBackInTheUnshownTailStaysOutOfTheView() = exercise((0 until 2_000).joinToString("") { "a paragraph $it\n\n" }) {
        engine.holdRender(true)
        barrier()
        var shown = 0
        var start = 0
        engine.handler.post { shown = if (engine.streaming) engine.tailStart() else -1; start = engine.text.indexOf("paragraph", shown) }
        barrier()
        // A word starting a few characters into the tail: its text, put back, would be an edit past the view's end.
        assertTrue("fixture: $start must lie just past the shown $shown", shown > 0 && start in shown + 2..shown + 9)
        engine.handler.post {
            engine.select(start, start, fromView = false, finishTail = false)
            engine.imeSetComposingRegion(start, start + "paragraph".length)
            engine.imeSetComposing("")
            engine.imeCommit("paragraph")
        }
        barrier()
        engine.holdRender(false)
        awaitComplete()
        assertEquals(original, source())
        val display = display()
        ui { assertEquals(display + TextFirstEditText.END_SENTINEL, controller.view.text.toString()) }
    }

    private fun exercise(body: String? = null, check: StreamingRig.() -> Unit) = streamingExercise(body, check)
}

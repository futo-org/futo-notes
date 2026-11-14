package com.futo.notes.textfirst

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import uniffi.futo_notes_ffi.EditorInlineFormat

/** A tap the user makes while an earlier command still runs is their newest action. */
class TextFirstTapDuringCommandTest {
    @Test fun aTapDuringALongCommandPlacesTheCaretForTheNextKeystroke() = streamingExercise {
        engine.selectAll()
        engine.toggleFormat(EditorInlineFormat.BOLD)
        barrier()
        awaitComplete()
        // The second toggle is the long command; the tap and the key arrive while it runs.
        val blocked = CountDownLatch(1)
        val resume = CountDownLatch(1)
        engine.handler.post { blocked.countDown(); check(resume.await(10, TimeUnit.SECONDS)) }
        assertTrue(blocked.await(10, TimeUnit.SECONDS))
        try {
            engine.toggleFormat(EditorInlineFormat.BOLD)
            ui { controller.view.setSelection(5) }
            engine.handler.post { engine.imeCommit("x") }
        } finally { resume.countDown() }
        barrier()
        awaitComplete()
        assertEquals(original.take(5) + "x" + original.drop(5), source())
        ui {
            assertEquals(6, controller.view.selectionStart)
            assertEquals(6, controller.view.selectionEnd)
        }
    }

    @Test fun aTableCellTapDuringALongCommandStillOpensTheCell() = streamingExercise(
        "| a | b |\n|---|---|\n| 1 | 2 |\n\n" + (0 until 2_000).joinToString("") { "paragraph $it\n\n" },
    ) {
        val cell = display().indexOf('2').also { assertTrue(it > 0) }
        engine.selectAll()
        barrier()
        awaitComplete()
        val blocked = CountDownLatch(1)
        val resume = CountDownLatch(1)
        engine.handler.post { blocked.countDown(); check(resume.await(10, TimeUnit.SECONDS)) }
        assertTrue(blocked.await(10, TimeUnit.SECONDS))
        try {
            engine.toggleFormat(EditorInlineFormat.BOLD)
            ui { controller.view.onTableCell!!(cell, cell, controller.view.appliedSeq) }
        } finally { resume.countDown() }
        barrier()
        var editing = false
        var caret = -1
        engine.handler.post { editing = engine.editingCell; caret = engine.selStart }
        barrier()
        assertTrue("the tapped cell opens", editing)
        assertEquals(cell, caret)
    }
}

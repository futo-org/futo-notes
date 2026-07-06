package com.futo.notes

import com.futo.notes.ui.isAtListTop
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Regression for the rank-change re-pin [list.md:24]: a note created via the
 * FAB (or re-ranked by an edit) was invisible above the viewport — or a 2px
 * sliver — until relaunch, because the snap-to-top decision and the resort ran
 * against stale state. These pin the two extracted pieces: the at-top
 * predicate (only an at-top viewport re-pins; deep scrolls are preserved
 * [list.md:26]) and the resort comparator (must equal a fresh reload's
 * `(modified_ms desc, id asc)` scan order).
 */
class NoteListRepinTest {
    // ── isAtListTop ──

    @Test
    fun exactTopIsAtTop() {
        assertTrue(isAtListTop(firstVisibleItemIndex = 0, firstVisibleItemScrollOffset = 0))
    }

    @Test
    fun subRowSettleSlopStillCountsAsTop() {
        assertTrue(isAtListTop(firstVisibleItemIndex = 0, firstVisibleItemScrollOffset = 4))
    }

    @Test
    fun scrolledPastSlopIsNotTop() {
        assertFalse(isAtListTop(firstVisibleItemIndex = 0, firstVisibleItemScrollOffset = 5))
    }

    @Test
    fun deepScrollIsNotTopEvenAtZeroOffset() {
        assertFalse(isAtListTop(firstVisibleItemIndex = 1, firstVisibleItemScrollOffset = 0))
        assertFalse(isAtListTop(firstVisibleItemIndex = 12, firstVisibleItemScrollOffset = 380))
    }

    // ── noteListOrder ──

    private fun item(id: String, modifiedMs: Long) = NoteItem(
        id = id,
        title = id,
        folder = "",
        modifiedMs = modifiedMs,
        preview = "",
        richPreview = "",
        tags = emptyList(),
    )

    @Test
    fun mostRecentlyModifiedFirst() {
        val sorted = listOf(item("a", 1L), item("c", 3L), item("b", 2L)).sortedWith(noteListOrder)
        assertEquals(listOf("c", "b", "a"), sorted.map { it.id })
    }

    @Test
    fun idAscendingBreaksModifiedTies() {
        val sorted = listOf(item("z", 5L), item("a", 5L), item("m", 5L)).sortedWith(noteListOrder)
        assertEquals(listOf("a", "m", "z"), sorted.map { it.id })
    }

    @Test
    fun resortOfAlreadySortedListIsStable() {
        val notes = listOf(item("new", 9L), item("a", 5L), item("b", 5L), item("old", 1L))
        assertEquals(notes, notes.sortedWith(noteListOrder))
    }
}

package com.futo.notes

import com.futo.notes.ui.isAtListTop
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NoteListRepinTest {
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
}

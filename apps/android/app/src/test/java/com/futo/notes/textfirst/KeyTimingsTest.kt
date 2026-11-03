package com.futo.notes.textfirst

import org.junit.Assert.assertEquals
import org.junit.Test

class KeyTimingsTest {
    @Test
    fun processingBudgetDoesNotCountQueueOrRefreshWaiting() {
        val timings = KeyTimings(
            input = 100, posted = 106, engine = 105,
            applyStart = 120, editsEnd = 122, applyEnd = 123,
            drawStart = 140, drawEnd = 142,
        )
        assertEquals(11L, timings.workNanos)
        assertEquals(42L, timings.drawEnd - timings.input)
    }
}

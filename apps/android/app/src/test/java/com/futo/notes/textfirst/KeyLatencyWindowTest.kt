package com.futo.notes.textfirst

import org.junit.Assert.*
import org.junit.Test

class KeyLatencyWindowTest {
    private fun sample(input: Long, response: Long = 20_000_000L) = KeyTimings(
        input, input + 2_000_000L, input + 1_000_000L,
        input + 3_000_000L, input + 4_000_000L, input + 5_000_000L,
        input + response - 1_000_000L, input + response,
    )

    @Test fun includesThePartialTailAndItsSlowFinalDelete() {
        val window = KeyLatencyWindow(3)
        assertNull(window.add(sample(1_000_000L)))
        assertNull(window.add(sample(200_000_000L)))
        assertEquals(3, window.add(sample(400_000_000L))!!.count)
        assertNull(window.add(sample(600_000_000L, 80_000_000L)))
        val tail = window.flush()!!
        assertEquals(1, tail.count)
        assertEquals(80.0, tail.p95, 0.0)
        assertEquals(600_000_000L, tail.lastInputNs)
        assertNull(window.flush())
    }

    @Test fun idleFlushDoesNotForgetWhetherNextInputResumesTyping() {
        val window = KeyLatencyWindow()
        window.add(sample(1_000_000L, 40_000_000L))
        assertEquals(40.0, window.flush()!!.resumeMax, 0.0)
        window.add(sample(1_900_000_000L, 60_000_000L))
        assertEquals(60.0, window.flush()!!.resumeMax, 0.0)
        window.add(sample(2_100_000_000L))
        assertEquals(0.0, window.flush()!!.resumeMax, 0.0)
    }
}

package com.futo.notes.textfirst

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CaretEdgeHapticsTest {
    @Test
    fun onlyAChangedLineAtLowSpeedTicks(): Unit {
        val haptics = CaretEdgeHaptics()
        assertFalse(haptics.allowLineTick(lineChanged = false, linesPerSecond = 4f, frameNanos = 0))
        assertFalse(haptics.allowLineTick(lineChanged = true, linesPerSecond = 6.01f, frameNanos = 0))
        assertTrue(haptics.allowLineTick(lineChanged = true, linesPerSecond = 6f, frameNanos = 0))
    }

    @Test
    fun consecutiveTicksAreAtLeastASixthOfASecondApart(): Unit {
        val haptics = CaretEdgeHaptics()
        assertTrue(haptics.allowLineTick(lineChanged = true, linesPerSecond = 4f, frameNanos = 0))
        assertFalse(haptics.allowLineTick(lineChanged = true, linesPerSecond = 4f, frameNanos = 166_666_666))
        assertTrue(haptics.allowLineTick(lineChanged = true, linesPerSecond = 4f, frameNanos = 166_666_667))
    }
}

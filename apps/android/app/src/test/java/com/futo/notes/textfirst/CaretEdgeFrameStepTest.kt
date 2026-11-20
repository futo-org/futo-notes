package com.futo.notes.textfirst

import org.junit.Assert.assertEquals
import org.junit.Test

class CaretEdgeFrameStepTest {
    @Test
    fun equalTimeCoversEqualDistanceAt60And120Hz(): Unit {
        for (velocity in listOf(-821f, 3000f, 5250f)) {
            for (refreshRate in listOf(60, 120)) {
                val step = CaretEdgeFrameStep()
                val distance = (1..refreshRate).sumOf { frame ->
                    val elapsedNanos = frame * 1_000_000_000L / refreshRate -
                        (frame - 1) * 1_000_000_000L / refreshRate
                    step.scrollPixels(velocity, elapsedNanos)
                }
                assertEquals(velocity, distance.toFloat(), 1f)
            }
        }
    }

    @Test
    fun aLateFrameKeepsItsFullTravel(): Unit {
        val step = CaretEdgeFrameStep()
        assertEquals(-192, step.scrollPixels(-3000f, 64_000_000))
    }

    @Test
    fun aStallTravelsNoMoreThanATenthOfASecond(): Unit {
        val step = CaretEdgeFrameStep()
        assertEquals(300, step.scrollPixels(3000f, 500_000_000))
    }

    @Test
    fun fractionalTravelIsCarriedUntilTheNextPixel(): Unit {
        val step = CaretEdgeFrameStep()
        assertEquals(0, step.scrollPixels(400f, 1_000_000))
        assertEquals(0, step.scrollPixels(400f, 1_000_000))
        assertEquals(1, step.scrollPixels(400f, 1_000_000))
        step.reset()
        assertEquals(0, step.scrollPixels(400f, 2_000_000))
    }
}

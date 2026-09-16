package com.futo.notes.sync.hosted

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.Instant

/**
 * The clock the pairing screen shows. It only ever describes the relay's
 * deadline — Rust decides when a code is dead — so what matters here is that it
 * never reads longer than the truth.
 */
class PairingCountdownTest {
    private val now = Instant.parse("2026-09-15T20:00:00Z").toEpochMilli()

    @Test
    fun `whole seconds are counted up, so a code never reads shorter than it is`() {
        assertEquals(300, pairingSecondsRemaining("2026-09-15T20:05:00Z", now))
        // 4.5s left reads as 5, not 4: rounding down would show 0:00 while the
        // code is still live.
        assertEquals(5, pairingSecondsRemaining("2026-09-15T20:00:04.500Z", now))
    }

    @Test
    fun `an offset is read the same whether it is written Z or plus zero`() {
        assertEquals(
            pairingSecondsRemaining("2026-09-15T20:05:00Z", now),
            pairingSecondsRemaining("2026-09-15T20:05:00+00:00", now),
        )
        // A real offset, not just a spelling of UTC.
        assertEquals(300, pairingSecondsRemaining("2026-09-15T22:05:00+02:00", now))
    }

    @Test
    fun `a past deadline is no time left, never negative`() {
        assertEquals(0, pairingSecondsRemaining("2026-09-15T19:59:00Z", now))
    }

    @Test
    fun `an unreadable timestamp reads as spent rather than as time in hand`() {
        assertEquals(0, pairingSecondsRemaining("not a date", now))
        assertEquals(0, pairingSecondsRemaining("", now))
    }

    @Test
    fun `the clock is written m colon ss`() {
        assertEquals("5:00", formatPairingCountdown(300))
        assertEquals("0:09", formatPairingCountdown(9))
        assertEquals("0:00", formatPairingCountdown(0))
        assertEquals("0:00", formatPairingCountdown(-3))
        assertEquals("1:01", formatPairingCountdown(61))
    }
}

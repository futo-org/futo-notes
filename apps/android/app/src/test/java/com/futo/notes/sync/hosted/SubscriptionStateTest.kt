package com.futo.notes.sync.hosted

import org.junit.Assert.assertEquals
import org.junit.Test
import uniffi.futo_notes_ffi.BillingStatus

/**
 * The subscription in words. The payment provider's vocabulary becomes a
 * sentence exactly here, and a state nobody recognised must still say something
 * true.
 */
class SubscriptionStateTest {
    /** Stands in for the relative-time renderer, so the wording is pinned. */
    private val relativeTime: (Long) -> String = { "in 4 days" }

    private fun billing(
        state: String,
        entitled: Boolean = true,
        graceUntil: String? = null,
    ) = BillingStatus(
        entitled = entitled,
        state = state,
        graceUntil = graceUntil,
        storageQuotaBytes = 10_000_000_000uL,
        blobMaxBytes = 104_857_600uL,
        bytesUsed = 4_210_688uL,
    )

    @Test
    fun `each state the provider sends has its own wording`() {
        val cases = listOf(
            "active" to "sync.hosted.account.state.active",
            "trialing" to "sync.hosted.account.state.trialing",
            "canceled" to "sync.hosted.account.state.expired",
            "paused" to "sync.hosted.account.state.paused",
            "incomplete" to "sync.hosted.account.state.incomplete",
            "incomplete_expired" to "sync.hosted.account.state.incomplete",
            "none" to "sync.hosted.account.state.none",
        )
        for ((state, path) in cases) {
            assertEquals(path, subscriptionStateMessage(billing(state), relativeTime).path)
        }
    }

    @Test
    fun `a failed payment says when sync will pause`() {
        val message = subscriptionStateMessage(
            billing("past_due", graceUntil = "2026-09-22T00:00:00Z"),
            relativeTime,
        )
        assertEquals("sync.hosted.account.state.pastDue", message.path)
        assertEquals("in 4 days", message.arguments["when"])
    }

    @Test
    fun `fractional seconds in the grace date are still a date`() {
        val message = subscriptionStateMessage(
            billing("unpaid", graceUntil = "2026-09-22T00:00:00.123Z"),
            relativeTime,
        )
        assertEquals("sync.hosted.account.state.pastDue", message.path)
    }

    @Test
    fun `a failed payment with no usable date still says payment failed`() {
        assertEquals(
            "sync.hosted.account.state.pastDueNoDate",
            subscriptionStateMessage(billing("past_due", graceUntil = null), relativeTime).path,
        )
        assertEquals(
            "sync.hosted.account.state.pastDueNoDate",
            subscriptionStateMessage(
                billing("past_due", graceUntil = "not a date"),
                relativeTime,
            ).path,
        )
    }

    @Test
    fun `a state nobody recognised falls back to the entitlement`() {
        assertEquals(
            "sync.hosted.account.state.active",
            subscriptionStateMessage(billing("something_new", entitled = true), relativeTime).path,
        )
        assertEquals(
            "sync.hosted.account.state.none",
            subscriptionStateMessage(billing("something_new", entitled = false), relativeTime).path,
        )
    }
}

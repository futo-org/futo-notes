package com.futo.notes.sync.hosted

import com.futo.notes.localization.LocalizedMessage
import java.time.Instant
import java.time.format.DateTimeParseException
import uniffi.futo_notes_ffi.BillingStatus

/**
 * The subscription, in words.
 *
 * `state` is the payment provider's own vocabulary, carried through Rust
 * verbatim, so this is where it becomes a sentence a person reads (ADR 0003,
 * decision 8). An unrecognised state falls back to the entitlement — the one
 * field that is always meaningful — rather than showing the raw word.
 *
 * A past-due account says when sync stops, because the grace period is the only
 * part of this a person can still act on. [relativeTime] is a parameter because
 * that date is rendered relative to now — and because taking the one function
 * this needs, rather than the whole `Localization`, is what lets a JVM unit test
 * read the wording without an Android runtime under it.
 *
 * A hand-written mirror of `src/features/sync/subscriptionState.ts` and
 * `apps/ios/Sources/Sync/Hosted/SubscriptionState.swift`, registered in
 * `scripts/drift-registry.json`.
 */
fun subscriptionStateMessage(
    billing: BillingStatus,
    relativeTime: (Long) -> String,
): LocalizedMessage = when (billing.state) {
    "active" -> LocalizedMessage("sync.hosted.account.state.active")
    "trialing" -> LocalizedMessage("sync.hosted.account.state.trialing")
    "past_due", "unpaid" -> pastDueMessage(billing.graceUntil, relativeTime)
    "canceled" -> LocalizedMessage("sync.hosted.account.state.expired")
    "paused" -> LocalizedMessage("sync.hosted.account.state.paused")
    "incomplete", "incomplete_expired" -> LocalizedMessage("sync.hosted.account.state.incomplete")
    "none" -> LocalizedMessage("sync.hosted.account.state.none")
    else ->
        if (billing.entitled) {
            LocalizedMessage("sync.hosted.account.state.active")
        } else {
            LocalizedMessage("sync.hosted.account.state.none")
        }
}

private fun pastDueMessage(
    graceUntil: String?,
    relativeTime: (Long) -> String,
): LocalizedMessage {
    val millis = graceUntil?.let(::timestampMillis)
        ?: return LocalizedMessage("sync.hosted.account.state.pastDueNoDate")
    return LocalizedMessage(
        "sync.hosted.account.state.pastDue",
        mapOf("when" to relativeTime(millis)),
    )
}

/**
 * The server sends RFC 3339, with or without fractional seconds. Anything else
 * is treated as no date at all rather than rendered wrong.
 */
private fun timestampMillis(iso8601: String): Long? = try {
    Instant.parse(iso8601).toEpochMilli()
} catch (_: DateTimeParseException) {
    null
}

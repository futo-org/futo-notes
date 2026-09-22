package com.futo.notes.sync.hosted

import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import kotlin.math.ceil
import kotlin.math.max

/**
 * How long a pairing code has left, as a person reads it.
 *
 * The countdown is a **display** of the relay's own `expires_at` and nothing
 * more. What actually ends a wait is Rust: `await_pairing` rebuilds its poll
 * schedule from that same timestamp and answers `pairingExpired` when the
 * window closes. Two clocks deciding one fact is how a screen ends up saying
 * "0:00" next to a live code, or "4:59" next to a dead one — so this one only
 * ever describes.
 *
 * A hand-written mirror of `src/features/sync/pairingCountdown.ts` and
 * `apps/ios/Sources/Sync/Hosted/PairingCountdown.swift`, registered in
 * `scripts/drift-registry.json`.
 */

/**
 * Whole seconds left before [expiresAt], never negative. An unreadable
 * timestamp reads as no time left, which is the safe way to be wrong: it shows
 * the code as spent rather than promising time it may not have.
 *
 * `ISO_OFFSET_DATE_TIME` rather than [java.time.Instant.parse] because the
 * relay's offset may be written `Z` or `+00:00`, with or without fractional
 * seconds, and on API 28 `Instant.parse` accepts only the first of those.
 */
fun pairingSecondsRemaining(expiresAt: String, nowMillis: Long = System.currentTimeMillis()): Int {
    val expiry = try {
        OffsetDateTime.parse(expiresAt, DateTimeFormatter.ISO_OFFSET_DATE_TIME)
            .toInstant()
            .toEpochMilli()
    } catch (_: DateTimeParseException) {
        return 0
    }
    return max(0, ceil((expiry - nowMillis) / 1000.0).toInt())
}

/** `m:ss`, the shape a countdown is read in. */
fun formatPairingCountdown(seconds: Int): String {
    val whole = max(0, seconds)
    return "${whole / 60}:${(whole % 60).toString().padStart(2, '0')}"
}

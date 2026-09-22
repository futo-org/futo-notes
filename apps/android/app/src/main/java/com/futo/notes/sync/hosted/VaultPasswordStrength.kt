package com.futo.notes.sync.hosted

import kotlin.math.log2
import kotlin.math.min

/**
 * The strength estimate shown while a person chooses a vault password.
 *
 * Length is the only *rule* — Rust owns the 12-character minimum and there are
 * no composition rules (ADR 0003, decision 7). This is advice on top of it, and
 * deliberately a small local estimate rather than a password-strength library:
 * zxcvbn and its ports carry a multi-hundred-kilobyte dictionary, and this is
 * the only screen in the app that would ever ask.
 *
 * A hand-written mirror of `src/features/sync/vaultPasswordStrength.ts` and
 * `apps/ios/Sources/Sync/Hosted/VaultPasswordStrength.swift`, registered in
 * `scripts/drift-registry.json`. It counts Unicode code points, not UTF-16
 * units, because that is what the TypeScript copy (`[...password]`) and Rust's
 * own minimum (`chars().count()`) count.
 */
enum class VaultPasswordStrength(val catalogSuffix: String) {
    TOO_SHORT("tooShort"),
    WEAK("weak"),
    FAIR("fair"),
    STRONG("strong"),
}

/** Size of each character pool a password draws from. */
private val POOLS: List<Pair<(Int) -> Boolean, Double>> = listOf(
    Pair({ c: Int -> c in 'a'.code..'z'.code }, 26.0),
    Pair({ c: Int -> c in 'A'.code..'Z'.code }, 26.0),
    Pair({ c: Int -> c in '0'.code..'9'.code }, 10.0),
    Pair(
        { c: Int ->
            !(c in 'a'.code..'z'.code || c in 'A'.code..'Z'.code || c in '0'.code..'9'.code)
        },
        33.0,
    ),
)

private const val FAIR_BITS = 45.0
private const val STRONG_BITS = 70.0

fun vaultPasswordStrength(password: String, minimumLength: Int): VaultPasswordStrength {
    val codePoints = password.codePoints().toArray().toList()
    if (codePoints.size < minimumLength) return VaultPasswordStrength.TOO_SHORT

    val bits = estimatedBits(codePoints)
    if (bits >= STRONG_BITS) return VaultPasswordStrength.STRONG
    if (bits >= FAIR_BITS) return VaultPasswordStrength.FAIR
    return VaultPasswordStrength.WEAK
}

/**
 * Roughly how much guessing this password costs: its length against the pools
 * it draws from, with length capped at twice the number of distinct characters.
 * That cap is what stops sixteen identical letters — long enough to pass the
 * minimum — from being reported as anything but weak, while leaving an ordinary
 * password's length untouched.
 */
private fun estimatedBits(codePoints: List<Int>): Double {
    val pool = POOLS.fold(0.0) { total, (contains, size) ->
        if (codePoints.any(contains)) total + size else total
    }
    if (pool == 0.0) return 0.0
    val distinct = codePoints.toSet().size
    val effectiveLength = min(codePoints.size, distinct * 2).toDouble()
    return effectiveLength * log2(pool)
}

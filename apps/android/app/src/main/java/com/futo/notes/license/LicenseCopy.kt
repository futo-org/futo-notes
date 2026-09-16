package com.futo.notes.license

import com.futo.notes.localization.Localization
import uniffi.futo_notes_ffi.LicenseAction
import uniffi.futo_notes_ffi.LicenseStatus
import uniffi.futo_notes_ffi.LicenseView

/** The one logcat tag for everything license — `just emu-logs` lists it. */
internal const val LICENSE_LOG_TAG = "FutoLicense"

/** Four U+00B7 middle dots — one masked group of the key. */
private const val MASK_GROUP = "····"

/** A key is eight groups; the card shows the last one and masks the rest. */
private const val MASKED_GROUPS = 7
private const val LAST_GROUP_LENGTH = 4

/**
 * What the License card renders, once per state.
 *
 * Every field is a finished string for the composable to place: the model
 * decides nothing about the license itself, and [status] is Rust's answer
 * carried through (the one exception is the Expired guard, which falls back to
 * the Unlicensed card rather than rendering a half-built date).
 *
 * @property status already judged by Rust; never re-derived here.
 * @property badge Unlicensed and Expired name themselves; Licensed is said by
 *   the coin.
 * @property since the purchase date, or null when the activation carried none
 *   — the row is present and blank, and nothing is invented to fill it.
 * @property term "Perpetual", "Valid until {date}" or "Expired {date}"; empty
 *   when there is no license to have a term.
 * @property maskedKey the stored key, masked to its last group; null with no
 *   license.
 */
data class LicenseCardModel(
    val status: LicenseStatus,
    val badge: String?,
    val since: String?,
    val term: String,
    val maskedKey: String?,
)

/**
 * How a license state reads on the card. Pure: state in, strings out.
 *
 * Presentation only — which catalog entry a state selects, which timestamps it
 * formats, and how the stored key is masked. Whether a license *is* licensed,
 * expired or invalid is decided in Rust (`futo-notes-license`, via
 * `licenseEvaluate`) and arrives already judged, so nothing here re-derives it
 * (AGENTS.md M6). Mirrors iOS `LicenseCopy.swift` and desktop `licenseCopy.ts`.
 */
fun licenseCardModel(view: LicenseView, localization: Localization): LicenseCardModel =
    when (view.status) {
        LicenseStatus.UNLICENSED -> unlicensedCard(localization)
        LicenseStatus.EXPIRED -> {
            // Only a v2 activation whose `expires_at` has passed reaches
            // Expired, so both dates are always there. The guard is kept, and
            // kept identical to the iOS and desktop copy, so the three cannot
            // drift over an impossible case — and no card is ever dated "NaN".
            val issuedAt = view.issuedAtMillis
            val expiresAt = view.expiresAtMillis
            if (issuedAt == null || expiresAt == null) {
                unlicensedCard(localization)
            } else {
                LicenseCardModel(
                    status = LicenseStatus.EXPIRED,
                    badge = localization.localizedText("license.statusExpired"),
                    since = localization.localizedAbsoluteDate(issuedAt),
                    term = localization.localizedText(
                        "license.card.termExpired",
                        mapOf("date" to localization.localizedAbsoluteDate(expiresAt)),
                    ),
                    maskedKey = view.key?.let(::maskLicenseKey),
                )
            }
        }
        LicenseStatus.LICENSED -> {
            // A v1 activation carries no purchase time: `since` is null, the
            // row renders blank, and no stand-in date is put in its place
            // (decision 2026-09-16 D2, issue #161). It is perpetual by format,
            // not by guess.
            val expiresAt = view.expiresAtMillis
            LicenseCardModel(
                status = LicenseStatus.LICENSED,
                // Licensed wears no badge: the coin in the well is the statement.
                badge = null,
                since = view.issuedAtMillis?.let(localization::localizedAbsoluteDate),
                term = if (expiresAt == null) {
                    localization.localizedText("license.card.termPerpetual")
                } else {
                    localization.localizedText(
                        "license.card.termValidUntil",
                        mapOf("date" to localization.localizedAbsoluteDate(expiresAt)),
                    )
                },
                maskedKey = view.key?.let(::maskLicenseKey),
            )
        }
    }

private fun unlicensedCard(localization: Localization) = LicenseCardModel(
    status = LicenseStatus.UNLICENSED,
    badge = localization.localizedText("license.unlicensed"),
    since = null,
    term = "",
    maskedKey = null,
)

/**
 * The stored key with everything but its last group replaced by dots:
 * `···· ···· ···· ···· ···· ···· ···· 6UJV`. The key arrives normalized
 * (trimmed, uppercased) from the Rust crate, so it is sliced as it stands.
 */
private fun maskLicenseKey(key: String): String =
    (List(MASKED_GROUPS) { MASK_GROUP } + key.takeLast(LAST_GROUP_LENGTH)).joinToString(" ")

/**
 * The catalog entry each control's label comes from. Copy is
 * `languages/en.json`'s (§5); this only says which entry, and it is exhaustive
 * so a new action in Rust fails the Kotlin compile rather than rendering blank.
 */
internal fun LicenseAction.catalogPath(): String = when (this) {
    LicenseAction.BUY -> "license.buy"
    LicenseAction.RENEW -> "license.renew"
    LicenseAction.ENTER_KEY -> "license.enterKey"
    LicenseAction.LOST_KEY -> "license.lostKey"
    LicenseAction.REMOVE -> "license.remove"
}

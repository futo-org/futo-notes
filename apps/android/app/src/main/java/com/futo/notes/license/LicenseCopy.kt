package com.futo.notes.license

import com.futo.notes.localization.Localization
import uniffi.futo_notes_ffi.LicenseAction
import uniffi.futo_notes_ffi.LicenseStatus
import uniffi.futo_notes_ffi.LicenseView

/** The one logcat tag for everything license — `just emu-logs` lists it. */
internal const val LICENSE_LOG_TAG = "FutoLicense"

/**
 * How a license state reads on the License row. Pure: state in, string out.
 *
 * Presentation only — which catalog entry a state selects and which timestamps
 * it formats. Whether a license *is* licensed, expired or invalid is decided in
 * Rust (`futo-notes-license`, via `licenseEvaluate`) and arrives already
 * judged, so nothing here re-derives it (AGENTS.md M6). Mirrors iOS
 * `LicenseCopy.swift` and desktop `licenseCopy.ts`.
 */
fun licenseRowText(view: LicenseView, localization: Localization): String = when (view.status) {
    LicenseStatus.LICENSED -> {
        // A v1 activation carries no purchase time, and there is no yearless
        // "Supporter since" to fall back to: the clause is dropped and the row
        // is the single word "Licensed" (decision 2026-09-10, issue #161).
        val issuedAt = view.issuedAtMillis
        val expiresAt = view.expiresAtMillis
        when {
            issuedAt == null -> localization.localizedText("license.licensedUndated")
            // A perpetual product has no expiry, and the row must not invent one.
            expiresAt == null -> localization.localizedText(
                "license.licensedPerpetual",
                mapOf("year" to localization.localizedYear(issuedAt)),
            )
            else -> localization.localizedText(
                "license.licensed",
                mapOf(
                    "year" to localization.localizedYear(issuedAt),
                    "date" to localization.localizedAbsoluteDate(expiresAt),
                ),
            )
        }
    }
    LicenseStatus.EXPIRED -> {
        // Only a v2 activation whose `expires_at` has passed reaches Expired,
        // so both dates are always there. The guard is kept, and kept identical
        // to the iOS and desktop copy, so the three cannot drift over an
        // impossible case.
        val issuedAt = view.issuedAtMillis
        val expiresAt = view.expiresAtMillis
        if (issuedAt == null || expiresAt == null) {
            localization.localizedText("license.unlicensed")
        } else {
            localization.localizedText(
                "license.expired",
                mapOf(
                    "year" to localization.localizedYear(issuedAt),
                    "date" to localization.localizedAbsoluteDate(expiresAt),
                ),
            )
        }
    }
    LicenseStatus.UNLICENSED -> localization.localizedText("license.unlicensed")
}

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

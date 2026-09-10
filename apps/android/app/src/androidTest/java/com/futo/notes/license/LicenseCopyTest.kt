package com.futo.notes.license

import com.futo.notes.localization.Localization
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import uniffi.futo_notes_ffi.LicenseStatus
import uniffi.futo_notes_ffi.LicenseView

/**
 * How each license state reads on the row. Instrumented because the dates go
 * through Android's ICU, which a JVM unit test does not have. Mirrors iOS
 * `LicenseCopyTests` and desktop `licenseCopy.test.ts`.
 */
class LicenseCopyTest {
    private val localization = Localization.fromGeneratedCatalogs(listOf("en"), "en-US")

    // 2026-01-15T10:30:00Z and 2029-01-15T10:30:00Z — the fixture license.
    private val issuedAt = 1_768_473_000_000L
    private val expiresAt = 1_863_138_600_000L

    @Test
    fun unlicensedIsTheAmbientLabel() {
        val text = licenseRowText(LicenseView(LicenseStatus.UNLICENSED, null, null), localization)

        assertEquals("Unlicensed", text)
    }

    @Test
    fun licensedNamesTheSupporterYearAndTheExpiry() {
        val text =
            licenseRowText(LicenseView(LicenseStatus.LICENSED, issuedAt, expiresAt), localization)

        assertTrue(text, text.startsWith("Licensed · Supporter since 2026 · Valid until "))
        assertTrue(text, text.contains("2029"))
        // A year is a date field, not a number: "2,026" would mean the copy went
        // through the number formatter.
        assertFalse(text, text.contains("2,026"))
    }

    /** A perpetual product has no expiry, and the row drops the clause rather
     *  than inventing a date. */
    @Test
    fun omitsTheExpiryEntirelyForAPerpetualLicense() {
        val text =
            licenseRowText(LicenseView(LicenseStatus.LICENSED, issuedAt, null), localization)

        assertEquals("Licensed · Supporter since 2026", text)
    }

    /**
     * The v1 reversal on this surface: still unmistakably the licensed state,
     * with the "Supporter since" clause simply gone. No yearless variant, no
     * placeholder year, and emphatically not the Unlicensed copy.
     */
    @Test
    fun aLicenseWithNoPurchaseYearDropsTheSinceClause() {
        val text = licenseRowText(LicenseView(LicenseStatus.LICENSED, null, null), localization)

        assertEquals("Licensed", text)
        assertFalse(text, text.contains("Supporter"))
        assertFalse(text, text.contains("Valid until"))
        // Nothing was substituted for the missing year — not this year, not any.
        assertFalse(text, text.contains(localization.localizedYear(System.currentTimeMillis())))
    }

    /** An expired license still says when it was bought — it is kept on the
     *  device and still earns "Supporter since". */
    @Test
    fun expiredKeepsTheSupporterYear() {
        val text =
            licenseRowText(LicenseView(LicenseStatus.EXPIRED, issuedAt, expiresAt), localization)

        assertTrue(text, text.startsWith("License expired "))
        assertTrue(text, text.endsWith("· Supporter since 2026"))
    }
}

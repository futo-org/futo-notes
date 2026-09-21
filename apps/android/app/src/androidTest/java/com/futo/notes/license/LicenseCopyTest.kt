package com.futo.notes.license

import com.futo.notes.localization.Localization
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import uniffi.futo_notes_ffi.LicenseStatus
import uniffi.futo_notes_ffi.LicenseView

/**
 * How each license state reads on the card. Instrumented because the dates go
 * through Android's ICU, which a JVM unit test does not have. Mirrors iOS
 * `LicenseCopyTests` and desktop `licenseCopy.test.ts`.
 */
class LicenseCopyTest {
    private val localization = Localization.fromGeneratedCatalogs(listOf("en"), "en-US")

    // 2026-01-15T10:30:00Z and 2029-01-15T10:30:00Z — the fixture license.
    private val issuedAt = 1_768_473_000_000L
    private val expiresAt = 1_863_138_600_000L

    // Eight hyphenated groups of four from the key alphabet (no I, L, O or 0),
    // in the normalized form the Rust crate stores and hands over.
    private val key = "AB12-CD34-EF56-GH78-JK9M-NP2Q-RS3T-6UJV"
    private val masked = "····-····-····-····-····-····-····-6UJV"

    private fun view(
        status: LicenseStatus,
        issued: Long?,
        expires: Long?,
        storedKey: String? = key,
    ) = LicenseView(status, issued, expires, if (status == LicenseStatus.UNLICENSED) null else storedKey)

    @Test
    fun unlicensedIsBadgedAndCarriesNothingElse() {
        val card = licenseCardModel(view(LicenseStatus.UNLICENSED, null, null), localization)

        assertEquals(LicenseStatus.UNLICENSED, card.status)
        assertEquals("Unlicensed", card.badge)
        assertNull(card.since)
        assertEquals("", card.term)
        assertNull(card.maskedKey)
    }

    @Test
    fun licensedNamesThePurchaseDateAndTheExpiry() {
        val card = licenseCardModel(view(LicenseStatus.LICENSED, issuedAt, expiresAt), localization)
        val since = card.since!!

        assertEquals(LicenseStatus.LICENSED, card.status)
        // Licensed is the state with no badge: the coin in the well says it.
        assertNull(card.badge)
        assertTrue(since, since.contains("2026"))
        // The full date, never a bare year (decision D3).
        assertFalse(since, since == "2026")
        // A year is a date field, not a number: "2,026" would mean the copy
        // went through the number formatter.
        assertFalse(since, since.contains("2,026"))
        assertTrue(card.term, card.term.startsWith("Valid until "))
        assertTrue(card.term, card.term.contains("2029"))
        assertEquals(masked, card.maskedKey)
    }

    /** A perpetual product has no expiry, and the term drops the date rather
     *  than inventing one. */
    @Test
    fun aLicenseWithNoExpiryReadsAsPerpetual() {
        val card = licenseCardModel(view(LicenseStatus.LICENSED, issuedAt, null), localization)
        val since = card.since!!

        assertEquals("Perpetual", card.term)
        assertTrue(since, since.contains("2026"))
    }

    /**
     * The v1 reality on this surface (decision D2): the since row is present
     * and blank. No dateless variant, no placeholder, no fetch time — and the
     * state is still unmistakably Licensed.
     */
    @Test
    fun aLicenseWithNoPurchaseDateLeavesTheSinceRowBlank() {
        val card = licenseCardModel(view(LicenseStatus.LICENSED, null, null), localization)

        assertEquals(LicenseStatus.LICENSED, card.status)
        assertNull(card.since)
        assertNull(card.badge)
        assertEquals("Perpetual", card.term)
        assertEquals(masked, card.maskedKey)
        // Nothing was substituted for the missing date — not this year, not any.
        assertFalse(
            card.term,
            card.term.contains(localization.localizedYear(System.currentTimeMillis())),
        )
    }

    /** An expired license still says when it was bought — it is kept on the
     *  device, and the purchase still happened. */
    @Test
    fun expiredIsBadgedAndDatesItsTerm() {
        val card = licenseCardModel(view(LicenseStatus.EXPIRED, issuedAt, expiresAt), localization)
        val since = card.since!!

        assertEquals(LicenseStatus.EXPIRED, card.status)
        assertEquals("Expired", card.badge)
        assertTrue(since, since.contains("2026"))
        assertTrue(card.term, card.term.startsWith("Expired "))
        assertTrue(card.term, card.term.contains("2029"))
        assertEquals(masked, card.maskedKey)
    }

    /**
     * Defensive: an Expired state can only come from a v2 activation whose
     * expiry passed, so it always has both dates. One arriving without them
     * must fall back to the whole Unlicensed card.
     */
    @Test
    fun anExpiredStateWithoutItsDatesFallsBackToUnlicensed() {
        val unlicensed =
            licenseCardModel(view(LicenseStatus.UNLICENSED, null, null), localization)

        assertEquals(
            unlicensed,
            licenseCardModel(view(LicenseStatus.EXPIRED, issuedAt, null), localization),
        )
        assertEquals(
            unlicensed,
            licenseCardModel(view(LicenseStatus.EXPIRED, null, expiresAt), localization),
        )
    }

    /** The whole point of the mask: seven groups of dots and the real last
     *  group, so a support conversation can name a key without the screen
     *  showing it. */
    @Test
    fun theMaskedKeyShowsOnlyTheLastGroup() {
        val card = licenseCardModel(view(LicenseStatus.LICENSED, issuedAt, expiresAt), localization)
        val maskedKey = card.maskedKey!!

        assertEquals(masked, maskedKey)
        assertTrue(maskedKey, maskedKey.endsWith("6UJV"))
        assertFalse(maskedKey, maskedKey.contains("AB12"))
        assertFalse(maskedKey, maskedKey.contains("RS3T"))
    }

    /**
     * What makes revealing the key an IN-PLACE swap rather than a jump: the mask
     * is the key's own length and keeps its hyphens in the same columns, so in a
     * monospace face every dot is replaced by the character that was under it.
     * The mask this replaced was a fixed 39 characters joined by spaces, so an
     * org-prefixed 42-character key slid three cells right as it appeared.
     */
    @Test
    fun theMaskIsTheKeysOwnLengthHyphensIncluded() {
        for (candidate in listOf(
            "AB12-CD34-EF56-GH78-JK9M-NP2Q-RS3T-6UJV",
            "FN-AB12-CD34-EF56-GH78-JK12-MN34-PQ56-RS78",
        )) {
            val card = licenseCardModel(
                LicenseView(
                    status = LicenseStatus.LICENSED,
                    issuedAtMillis = null,
                    expiresAtMillis = null,
                    key = candidate,
                ),
                localization,
            )
            val masked = card.maskedKey!!

            assertEquals(candidate.length, masked.length)
            assertFalse(masked, masked.contains(" "))
            // Every hyphen stays where it was; nothing else survives but the
            // last group.
            for (index in 0 until candidate.length - 4) {
                assertEquals(
                    "column $index of $masked",
                    if (candidate[index] == '-') '-' else '·',
                    masked[index],
                )
            }
            assertEquals(candidate.takeLast(4), masked.takeLast(4))
        }
    }
}

package com.futo.notes.ui.settings.appicon

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import uniffi.futo_notes_ffi.LicenseAction
import uniffi.futo_notes_ffi.LicenseInclusion
import uniffi.futo_notes_ffi.LicensePurchaseSurface.KEY_ONLY
import uniffi.futo_notes_ffi.LicensePurchaseSurface.LINK_OUT
import uniffi.futo_notes_ffi.LicensePurchaseSurface.NAME_WEBSITE

/**
 * What the picker draws per license state (docs/spec/settings.md § Native app
 * icons). The inputs are what Rust answers — `licenseIncludes` and
 * `licenseRowActions` — written out here because a JVM test cannot load the
 * FFI; the shape is a pure function of them. Mirrors iOS `AppIconPickerTests`.
 */
class AppIconPickerShapeTest {
    private val all = AppIcon.entries.toSet()
    private val linkOutUnlicensed = listOf(LicenseAction.BUY, LicenseAction.ENTER_KEY, LicenseAction.LOST_KEY)
    private val linkOutExpired = listOf(LicenseAction.RENEW, LicenseAction.ENTER_KEY, LicenseAction.LOST_KEY)
    private val keyOnly = listOf(LicenseAction.ENTER_KEY)

    @Test fun unlicensedLinkOutCoinsEveryTileButTheCurrentAndAsksWithBuy() {
        val shape = appIconPickerShape(AppIcon.FUTO, emptySet(), linkOutUnlicensed, LINK_OUT)
        assertEquals(all - AppIcon.FUTO, shape.coined)
        assertTrue(shape.footnote)
        assertEquals(AppIconPickerShape.Ask.LinkOut(LicenseAction.BUY), shape.ask)
        assertEquals("settings.appIcon.license.footnote", shape.footnoteKey)
        assertTrue(shape.asks(AppIcon.LIGHT_STANDARD))
        // Tapping the current tile stays a no-op, never an ask.
        assertFalse(shape.asks(AppIcon.FUTO))
    }

    @Test fun expiredAsksTheSameWithRenewWhereBuyWouldBe() {
        val shape = appIconPickerShape(AppIcon.DARK_STANDARD, emptySet(), linkOutExpired, LINK_OUT)
        assertEquals(all - AppIcon.DARK_STANDARD, shape.coined)
        assertTrue(shape.footnote)
        assertEquals(AppIconPickerShape.Ask.LinkOut(LicenseAction.RENEW), shape.ask)
    }

    @Test fun keyOnlyAsksWithoutBuyAndNeverSaysUnlock() {
        val shape = appIconPickerShape(AppIcon.LIGHT_STANDARD, emptySet(), keyOnly, KEY_ONLY)
        assertEquals(all - AppIcon.LIGHT_STANDARD, shape.coined)
        assertEquals(AppIconPickerShape.Ask.KeyOnly, shape.ask)
        assertEquals("settings.appIcon.license.footnoteKeyOnly", shape.footnoteKey)
    }

    @Test fun licensedKeepsTheCoinOnEveryIconButStandardAndNeverAsks() {
        for (selected in AppIcon.entries) {
            val shape = appIconPickerShape(selected, setOf(LicenseInclusion.APP_ICON), listOf(LicenseAction.REMOVE), NAME_WEBSITE)
            assertEquals(all - AppIcon.LIGHT_STANDARD, shape.coined)
            assertFalse(shape.footnote)
            assertEquals(null, shape.ask)
            assertTrue(AppIcon.entries.none(shape::asks))
        }
    }

    @Test fun anUnreadLicenseIsNeitherLicensedNorUnlicensed() {
        val shape = appIconPickerShape(AppIcon.FUTO, null, emptyList(), LINK_OUT)
        assertFalse(shape.resolved)
        assertEquals(emptySet<AppIcon>(), shape.coined)
        assertFalse(shape.footnote)
        assertEquals(null, shape.ask)
    }

    @Test fun playNamesTheWebsiteWithoutBuyOrUnlock() {
        val shape = appIconPickerShape(
            AppIcon.FUTO, emptySet(), listOf(LicenseAction.ENTER_KEY, LicenseAction.LOST_KEY), NAME_WEBSITE,
        )
        assertEquals(all - AppIcon.FUTO, shape.coined)
        assertEquals(AppIconPickerShape.Ask.NameWebsite, shape.ask)
        assertEquals("settings.appIcon.license.footnoteWebsite", shape.footnoteKey)
    }
}

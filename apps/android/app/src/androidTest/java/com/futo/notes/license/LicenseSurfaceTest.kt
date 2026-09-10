package com.futo.notes.license

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.test.platform.app.InstrumentationRegistry
import com.futo.notes.BuildConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import uniffi.futo_notes_ffi.LicenseAction
import uniffi.futo_notes_ffi.LicensePlatform
import uniffi.futo_notes_ffi.LicenseStatus
import uniffi.futo_notes_ffi.licenseDeepLinkScheme
import uniffi.futo_notes_ffi.licenseLinks
import uniffi.futo_notes_ffi.licenseRowActions

/**
 * What the BUILD promises about the license surface, where no test of the Rust
 * rules can see it: the manifest's URL scheme and the store-posture flag.
 * Mirrors iOS `LicenseSurfaceTests`.
 */
class LicenseSurfaceTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    /**
     * The scheme is registered at BUILD time, in `AndroidManifest.xml`, where no
     * test of the Rust rules can see it. This is the seam that catches a
     * manifest which lost the filter — the deep link would then simply never
     * arrive, with nothing failing to say so.
     *
     * It resolves the intent through the PackageManager exactly as a browser
     * handing over a `futonotes://` link would, then insists the app that
     * answers is THIS one: a filter that quietly stopped matching, or one only
     * some other app answers, both fail here.
     */
    @Test
    fun theAppAnswersTheCratesUrlScheme() {
        val link = Uri.parse("${licenseDeepLinkScheme()}://license/key/activation")
        val intent = Intent(Intent.ACTION_VIEW, link).addCategory(Intent.CATEGORY_BROWSABLE)

        val handlers = context.packageManager
            .queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY)
            .map { it.activityInfo.packageName }

        assertTrue(
            "no activity answers $link — handlers: $handlers",
            handlers.contains(BuildConfig.APPLICATION_ID),
        )
    }

    /**
     * `LICENSE_LINK_OUT` is `true` at launch on both flavors: the app ships the
     * full surface worldwide (docs/spec/license.md § Store posture). This is
     * the assertion to flip, together with the `play` line in
     * `app/build.gradle.kts`, if Google ever objects.
     */
    @Test
    fun theAppLinksOutAtLaunch() {
        assertTrue(BuildConfig.LICENSE_LINK_OUT)
    }

    /**
     * Both values of the flag, at the seam the row actually renders from, so
     * the consumption-only shape is exercised without a build flip: Buy, Renew
     * and Lost-your-key disappear and the key field stays.
     */
    @Test
    fun linkOutFalseKeepsTheKeyFieldAndHidesEveryWayOut() {
        assertEquals(
            listOf(LicenseAction.BUY, LicenseAction.ENTER_KEY, LicenseAction.LOST_KEY),
            licenseRowActions(LicenseStatus.UNLICENSED, true),
        )
        assertEquals(
            listOf(LicenseAction.RENEW, LicenseAction.ENTER_KEY, LicenseAction.LOST_KEY),
            licenseRowActions(LicenseStatus.EXPIRED, true),
        )
        assertEquals(
            listOf(LicenseAction.ENTER_KEY),
            licenseRowActions(LicenseStatus.UNLICENSED, false),
        )
        assertEquals(
            listOf(LicenseAction.ENTER_KEY),
            licenseRowActions(LicenseStatus.EXPIRED, false),
        )
        assertEquals(
            listOf(LicenseAction.REMOVE),
            licenseRowActions(LicenseStatus.LICENSED, false),
        )
    }

    /** The Buy link carries this platform, and it is a plain https URL the
     *  system browser can open — never an in-app WebView target. */
    @Test
    fun theBuyLinkIsThisPlatforms() {
        val links = licenseLinks(LicensePlatform.ANDROID)
        assertTrue(links.buy, links.buy.contains("platform=android"))
        assertTrue(links.buy, links.buy.startsWith("https://"))
        assertEquals("mailto:support@futo.tech", links.support)
    }
}

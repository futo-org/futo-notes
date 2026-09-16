package com.futo.notes.license

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.futo.notes.BuildConfig
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.localization.Localization
import com.futo.notes.ui.LicenseSettingsSection
import com.futo.notes.ui.theme.FutoNotesTheme
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
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
@RunWith(AndroidJUnit4::class)
class LicenseSurfaceTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @get:Rule
    val compose = createComposeRule()

    // A prefs file of this test's own: the app's real license must be neither
    // read nor written by a test run.
    private val preferences =
        context.getSharedPreferences("license-surface-test", Context.MODE_PRIVATE)

    @After
    fun clearPreferences() {
        preferences.edit().clear().commit()
    }

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
        val links = licenseLinks(LicensePlatform.ANDROID, "com.futo.notes")
        assertTrue(links.buy, links.buy.contains("platform=android"))
        assertTrue(links.buy, links.buy.startsWith("https://"))
        assertEquals("mailto:support@futo.tech", links.support)
    }

    /** The Buy destination follows the dev/prod split (M3), so the debug build
     *  that verifies against the staging key also buys on staging. */
    @Test
    fun theBuyLinkFollowsTheEnvironment() {
        val staging = licenseLinks(LicensePlatform.ANDROID, "com.futo.notes.dev").buy
        val production = licenseLinks(LicensePlatform.ANDROID, "com.futo.notes").buy
        assertTrue(staging, staging.startsWith("https://staging-pay2.futo.org/"))
        assertTrue(production, production.startsWith("https://pay2.futo.org/"))
    }

    /**
     * The card shows the stored key masked to its last group, and reveals the
     * whole thing — with a way to copy it — only when it is asked for (D4).
     *
     * A Compose test rather than a model one because the masking itself is
     * already locked at the model level (`LicenseCopyTest`): what is untested
     * anywhere else is that the plate STARTS masked, that the masked value is
     * the control, and that its accessible name says what tapping it does
     * instead of reading thirty-two middle dots aloud.
     */
    @Test
    fun theCardMasksTheStoredKeyAndRevealsItOnTap() {
        val localization = Localization.fromGeneratedCatalogs(listOf("en"), "en-US")
        val license = LicenseModel(LicenseStorage(preferences), LicenseFixture.DEV_APPLICATION_ID)
        license.showMessage = {}
        license.handle(LicenseFixture.deepLink)
        val view = checkNotNull(license.view) { "the fixture link did not license the device" }
        val storedKey = checkNotNull(view.key)
        val masked = checkNotNull(licenseCardModel(view, localization).maskedKey)

        compose.setContent {
            FutoNotesTheme(darkTheme = false) {
                CompositionLocalProvider(LocalLocalization provides localization) {
                    // The plate lives in a scrolling Settings column; give it
                    // one here too, so an assertion cannot fail merely because
                    // this device's screen is shorter than the card.
                    Column(Modifier.verticalScroll(rememberScrollState())) {
                        LicenseSettingsSection(license)
                    }
                }
            }
        }

        compose.onNodeWithText(masked).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(storedKey).assertDoesNotExist()

        compose
            .onNodeWithContentDescription(localization.localizedText("license.card.revealKey"))
            .performScrollTo()
            .performClick()

        compose.onNodeWithText(storedKey).performScrollTo().assertIsDisplayed()
        compose
            .onNodeWithText(localization.localizedText("license.card.copyKey"))
            .assertIsDisplayed()
        compose.onNodeWithText(masked).assertDoesNotExist()
    }
}


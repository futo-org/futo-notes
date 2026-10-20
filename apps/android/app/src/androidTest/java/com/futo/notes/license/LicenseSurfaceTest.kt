package com.futo.notes.license

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.futo.notes.localization.Localization
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.semantics.SemanticsProperties
import com.futo.notes.ui.LICENSE_WEBSITE_TAG
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import uniffi.futo_notes_ffi.LicenseAction
import uniffi.futo_notes_ffi.LicenseDistribution
import uniffi.futo_notes_ffi.LicensePurchaseSurface
import uniffi.futo_notes_ffi.LicenseStatus
import uniffi.futo_notes_ffi.licenseDeepLinkScheme
import uniffi.futo_notes_ffi.licenseEvaluate
import uniffi.futo_notes_ffi.licensePurchaseSurface
import uniffi.futo_notes_ffi.licenseSurfaceRowActions

/**
 * What the BUILD promises about the license surface, where no test of the Rust
 * rules can see it — the manifest's URL scheme — plus the rendered License
 * plate. The per-flavor distribution is `LicenseDistributionTest`'s, on both flavors.
 * Mirrors iOS `LicenseSurfaceTests`.
 */
@RunWith(AndroidJUnit4::class)
class LicenseSurfaceTest : LicenseSurfaceFixture() {
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
            .map { it.activityInfo.name }

        assertTrue(
            "no activity answers $link — handlers: $handlers",
            handlers.contains(LicenseLinkActivity::class.java.name),
        )
    }

    @Test
    fun thePurchaseSurfaceFollowsTheSharedCasesAndFlavor() {
        val fixture = JSONObject(
            InstrumentationRegistry.getInstrumentation().context.assets
                .open("license.json").bufferedReader().use { it.readText() },
        ).getJSONArray("purchaseSurface")
        assertEquals(8, fixture.length())
        for (index in 0 until fixture.length()) {
            val testCase = fixture.getJSONObject(index)
            val distribution = when (testCase.getString("distribution")) {
                "desktop" -> LicenseDistribution.DESKTOP
                "iosAppStore" -> LicenseDistribution.IOS_APP_STORE
                "androidDirect" -> LicenseDistribution.ANDROID_DIRECT
                else -> LicenseDistribution.ANDROID_PLAY
            }
            val expected = when (testCase.getString("expected")) {
                "linkOut" -> LicensePurchaseSurface.LINK_OUT
                "nameWebsite" -> LicensePurchaseSurface.NAME_WEBSITE
                else -> LicensePurchaseSurface.KEY_ONLY
            }
            assertEquals(
                testCase.getString("name"), expected,
                licensePurchaseSurface(
                    distribution,
                    if (testCase.isNull("storefrontCountry")) null else testCase.getString("storefrontCountry"),
                ),
            )
        }
    }

    /**
     * Every surface at the seam the row renders from, so `play`'s shape is
     * exercised without a build flip: no Buy or Renew, but "Lost your key?"
     * stays, because help leads to no payment.
     */
    @Test
    fun namingTheWebsiteKeepsTheKeyFieldAndHelpButNoCheckout() {
        assertEquals(
            listOf(LicenseAction.BUY, LicenseAction.ENTER_KEY, LicenseAction.LOST_KEY),
            licenseSurfaceRowActions(LicenseStatus.UNLICENSED, LicensePurchaseSurface.LINK_OUT),
        )
        assertEquals(
            listOf(LicenseAction.RENEW, LicenseAction.ENTER_KEY, LicenseAction.LOST_KEY),
            licenseSurfaceRowActions(LicenseStatus.EXPIRED, LicensePurchaseSurface.LINK_OUT),
        )
        for (status in listOf(LicenseStatus.UNLICENSED, LicenseStatus.EXPIRED)) {
            assertEquals(
                listOf(LicenseAction.ENTER_KEY, LicenseAction.LOST_KEY),
                licenseSurfaceRowActions(status, LicensePurchaseSurface.NAME_WEBSITE),
            )
        }
        assertEquals(
            listOf(LicenseAction.REMOVE),
            licenseSurfaceRowActions(LicenseStatus.LICENSED, LicensePurchaseSurface.NAME_WEBSITE),
        )
    }

    /**
     * `play` names the website and nothing more: the address is plain text with
     * no click action and no link annotation (Google Play's consumption-only
     * rule), under the same headline and reason `direct` shows, with no Buy.
     */
    @Test
    fun playNamesTheWebsiteAsTextThatCannotBeTapped() {
        val localization = Localization.fromGeneratedCatalogs(listOf("en"), "en-US")
        val license = LicenseModel(
            LicenseStorage(preferences),
            LicenseFixture.DEV_APPLICATION_ID,
            distribution = LicenseDistribution.ANDROID_PLAY,
        )
        license.showMessage = {}
        license.applyEvaluated(licenseEvaluate(null, LicenseFixture.DEV_APPLICATION_ID))

        showPlate(license, localization)

        compose.onNodeWithText(localization.localizedText("license.unlicensedHeadline")).assertExists()
        compose.onNodeWithText(localization.localizedText("license.explanation")).assertExists()
        val website = compose.onNodeWithTag(LICENSE_WEBSITE_TAG).performScrollTo()
        website.assertTextEquals(
            localization.localizedText("license.websiteExplanation", mapOf("url" to "staging-pay2.futo.org")),
        )
        website.assertHasNoClickAction()
        val text = website.fetchSemanticsNode().config[SemanticsProperties.Text].single()
        assertTrue("the address must not be a link", text.getLinkAnnotations(0, text.length).isEmpty())
        compose.onNodeWithText(localization.localizedText("license.buy")).assertDoesNotExist()
        compose.onNodeWithText(localization.localizedText("license.lostKey")).assertExists()
        compose.onNodeWithText(localization.localizedText("license.enterKey")).assertExists()
    }
}

package com.futo.notes.license

import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.contextmenu.data.TextContextMenuKeys
import androidx.compose.foundation.text.contextmenu.provider.LocalTextContextMenuToolbarProvider
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTouchInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.localization.Localization
import com.futo.notes.ui.LicenseSettingsSection
import com.futo.notes.ui.theme.FutoNotesTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import uniffi.futo_notes_ffi.LicenseDistribution
import uniffi.futo_notes_ffi.licenseEvaluate

/** The rendered License plate — card, letterhead, key reveal and copy. Mirrors iOS `LicenseSurfaceTests`. */
@RunWith(AndroidJUnit4::class)
class LicensePlateTest : LicenseSurfaceFixture() {
    /**
     * The card shows the stored key masked to its last group, and reveals the
     * whole thing only when it is asked for (D4). What it reveals is plain
     * text: there is no Copy control, because a license key should not be one
     * tap from the clipboard (@justin 2026-09-17).
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
        compose.onNodeWithText(masked).assertDoesNotExist()
    }

    /**
     * What the Licensed plate actually puts on screen after the 2026-09-18
     * port, and — more usefully — what it does NOT.
     *
     * "Licensed since" and "Term" are gone as rows: nothing records a purchase
     * date and nothing limits a license, so both only ever said blank or
     * "Perpetual". `licenseCardModel` still RETURNS both, unchanged and shared
     * across the three shells, which is why this asserts the SCREEN rather than
     * the model. Copy key is gone with them: a license key should not be one tap
     * from the clipboard.
     */
    @Test
    fun theLicensedPlateIsTheCoinTheLetterheadAndTheKey() {
        val localization = Localization.fromGeneratedCatalogs(listOf("en"), "en-US")
        val license = licensedModel()
        val view = checkNotNull(license.view)
        val card = licenseCardModel(view, localization)

        showPlate(license, localization)

        // The coin is here, and the letterhead with it.
        compose
            .onNodeWithContentDescription(
                localization.localizedText("license.coinAccessibilityLabel"),
            )
            .performScrollTo()
            .assertIsDisplayed()
        compose
            .onNodeWithText(localization.localizedText("license.card.eyebrow").uppercase())
            .assertExists()

        // Key is the whole ledger.
        compose
            .onNodeWithText(localization.localizedText("license.card.keyLabel").uppercase())
            .assertExists()
        // The fixture is a v2 activation, so the model DOES carry a date and a
        // term — and neither reaches the screen.
        assertNotNull("the fixture should carry a purchase date", card.since)
        compose.onNodeWithText(checkNotNull(card.since)).assertDoesNotExist()
        compose.onNodeWithText(card.term).assertDoesNotExist()

        // Licensed wears no badge, thanks rather than asks, and offers Remove
        // as its only action.
        compose.onNodeWithText(localization.localizedText("license.unlicensedHeadline"))
            .assertDoesNotExist()
        compose
            .onNodeWithText(localization.localizedText("license.explanationLicensed"))
            .assertExists()
        compose.onNodeWithText(localization.localizedText("license.remove")).assertExists()
    }

    /**
     * Unlicensed is an ask, not a card (@justin 2026-09-18): no badge, no
     * eyebrow, no product name — and no empty well, which read as something
     * that had failed to load rather than as "no license".
     *
     * The reason sits ABOVE the one filled button. Compose cannot be asked
     * "which of these is higher up" without reading geometry, so that is
     * exactly what this does: the mission paragraph's top must be above the Buy
     * button's.
     */
    @Test
    fun unlicensedLeadsWithTheAskAndCarriesNoCardChrome() {
        val localization = Localization.fromGeneratedCatalogs(listOf("en"), "en-US")
        // Direct pinned: this asserts the Buy surface, which the Play flavor
        // replaces by design (playNamesTheWebsiteAsTextThatCannotBeTapped).
        val license = LicenseModel(
            LicenseStorage(preferences),
            LicenseFixture.DEV_APPLICATION_ID,
            distribution = LicenseDistribution.ANDROID_DIRECT,
        )
        license.showMessage = {}
        license.applyEvaluated(licenseEvaluate(null, LicenseFixture.DEV_APPLICATION_ID))

        showPlate(license, localization)

        compose
            .onNodeWithText(localization.localizedText("license.unlicensedHeadline"))
            .performScrollTo()
            .assertIsDisplayed()
        compose
            .onNodeWithText(localization.localizedText("license.card.eyebrow").uppercase())
            .assertDoesNotExist()
        compose
            .onNodeWithText(localization.localizedText("license.card.productName").uppercase())
            .assertDoesNotExist()
        compose.onNodeWithText(localization.localizedText("license.unlicensed").uppercase())
            .assertDoesNotExist()
        compose
            .onNodeWithContentDescription(
                localization.localizedText("license.coinAccessibilityLabel"),
            )
            .assertDoesNotExist()
        compose
            .onNodeWithText(localization.localizedText("license.card.keyLabel").uppercase())
            .assertDoesNotExist()

        val reason = compose
            .onNodeWithText(localization.localizedText("license.explanation"))
            .performScrollTo()
            .fetchSemanticsNode()
            .boundsInRoot
        val buy = compose
            .onNodeWithText(localization.localizedText("license.buy"))
            .fetchSemanticsNode()
            .boundsInRoot
        assertTrue(
            "the reason (${'$'}{reason.top}) must sit above the Buy button (${'$'}{buy.top})",
            reason.top < buy.top,
        )
    }

    /**
     * Revealing the key moves NOTHING: the mask is the key's own length in a
     * monospace face, so the swap is glyph-for-glyph and the row keeps its box
     * (@justin 2026-09-18). Desktop and iOS hold this; Android visibly shifted,
     * which is the regression this pins.
     *
     * It reads geometry rather than looks, because "nothing shifts" is not
     * something a text assertion can see: the key's own box before and after,
     * and the top of the control below it.
     */
    @Test
    fun revealingTheKeyMovesNothingOnThePlate() {
        val localization = Localization.fromGeneratedCatalogs(listOf("en"), "en-US")
        val license = licensedModel()
        val view = checkNotNull(license.view)
        val storedKey = checkNotNull(view.key)
        val masked = checkNotNull(licenseCardModel(view, localization).maskedKey)
        val remove = localization.localizedText("license.remove")

        showPlate(license, localization)

        compose.onNodeWithText(masked).performScrollTo()
        val keyBefore = compose.onNodeWithText(masked).fetchSemanticsNode().boundsInRoot
        val removeBefore = compose.onNodeWithText(remove).fetchSemanticsNode().boundsInRoot

        compose
            .onNodeWithContentDescription(localization.localizedText("license.card.revealKey"))
            .performClick()

        val keyAfter = compose.onNodeWithText(storedKey).fetchSemanticsNode().boundsInRoot
        val removeAfter = compose.onNodeWithText(remove).fetchSemanticsNode().boundsInRoot

        assertEquals("the key row moved: $keyBefore -> $keyAfter", keyBefore, keyAfter)
        assertEquals(
            "the plate below the key moved: $removeBefore -> $removeAfter",
            removeBefore,
            removeAfter,
        )
    }

    /**
     * The revealed key is genuinely selectable, so select-and-copy can reach it.
     *
     * There is no Copy control by design (@justin 2026-09-17) — which only
     * means anything if select-and-copy WORKS. Compose text is not selectable
     * unless something puts a `SelectionContainer` over it, and this app had
     * none anywhere, so the 42 characters a buyer has to get off the phone
     * could only be transcribed by hand. Justin hit the same hole on desktop on
     * 2026-09-19.
     *
     * Asserted at the seam where a long press asks for the floating menu, not
     * by looking for a `SelectionContainer` in the tree: this fails for the
     * reason a user would — nothing offered Copy over the key — instead of
     * restating the source. That seam is `LocalTextContextMenuToolbarProvider`
     * and NOT `LocalTextToolbar`, because `ComposeFoundationFlags
     * .isNewContextMenuEnabled` ships true in Compose 1.9; a fake `TextToolbar`
     * records nothing at all here, which looks exactly like a broken fix.
     */
    @Test
    fun theRevealedKeyCanBeSelectedAndCopied() {
        val localization = Localization.fromGeneratedCatalogs(listOf("en"), "en-US")
        val license = licensedModel()
        val storedKey = checkNotNull(checkNotNull(license.view).key)
        val menu = RecordingTextContextMenu()

        compose.setContent {
            FutoNotesTheme(darkTheme = false) {
                CompositionLocalProvider(
                    LocalLocalization provides localization,
                    LocalTextContextMenuToolbarProvider provides menu,
                ) {
                    Column(Modifier.verticalScroll(rememberScrollState())) {
                        LicenseSettingsSection(license)
                    }
                }
            }
        }

        // Masked, the key is a control and nothing else: a long press on it
        // raises no selection menu. (It does reveal — `clickable` has no
        // long-press timeout, so the press still lands as the tap it is.)
        compose
            .onNodeWithContentDescription(localization.localizedText("license.card.revealKey"))
            .performScrollTo()
            .performTouchInput { longClick() }
        compose.waitForIdle()
        assertTrue(
            "the mask offered a selection menu: ${menu.components}",
            menu.components.isEmpty(),
        )

        compose.onNodeWithText(storedKey).performScrollTo().performTouchInput { longClick() }
        compose.waitForIdle()

        // Compose idleness does not guarantee that the provider coroutine has
        // published the menu produced by the real selection gesture.
        compose.waitUntil(5_000) { menu.item(TextContextMenuKeys.CopyKey) != null }
        val copy = menu.item(TextContextMenuKeys.CopyKey)
        assertNotNull("no Copy was offered over the revealed key: ${menu.components}", copy)

        // And Copy copies the key. A long press selects the word under it, so
        // what lands on the clipboard is a run of the key rather than all of it.
        val clipboard = checkNotNull(context.getSystemService(ClipboardManager::class.java))
        val sentinel = "clipboard sentinel before license Copy"
        compose.runOnUiThread {
            clipboard.setPrimaryClip(ClipData.newPlainText("license-copy-test", sentinel))
            assertEquals(sentinel, clipboard.primaryClip?.getItemAt(0)?.text?.toString())
            checkNotNull(copy).onClick(NoopSession)
        }
        compose.waitForIdle()
        val copied = clipboard.primaryClip?.getItemAt(0)?.text?.toString()
        assertNotNull("Copy put nothing on the clipboard", copied)
        assertTrue(
            "the clipboard holds \"$copied\", which is not part of $storedKey",
            checkNotNull(copied).isNotEmpty() && storedKey.contains(copied),
        )
    }
}

package com.futo.notes.license

import android.content.Context
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.contextmenu.data.TextContextMenuComponent
import androidx.compose.foundation.text.contextmenu.data.TextContextMenuItem
import androidx.compose.foundation.text.contextmenu.data.TextContextMenuSession
import androidx.compose.foundation.text.contextmenu.provider.TextContextMenuDataProvider
import androidx.compose.foundation.text.contextmenu.provider.TextContextMenuProvider
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.localization.Localization
import com.futo.notes.ui.LicenseSettingsSection
import com.futo.notes.ui.theme.FutoNotesTheme
import kotlinx.coroutines.awaitCancellation
import org.junit.After
import org.junit.Rule

/** The compose rule, the test-owned prefs file, and the plate harness both license surface test classes share. */
abstract class LicenseSurfaceFixture {
    protected val context = InstrumentationRegistry.getInstrumentation().targetContext

    @get:Rule
    val compose = createComposeRule()

    // A prefs file of this test's own: the app's real license must be neither
    // read nor written by a test run.
    protected val preferences =
        context.getSharedPreferences("license-surface-test", Context.MODE_PRIVATE)

    @After
    fun clearPreferences() {
        preferences.edit().clear().commit()
    }

    /**
     * The floating text menu, recorded instead of shown. `showTextContextMenu`
     * suspends for as long as the menu is up, so this parks rather than
     * returning — returning immediately would tell Compose the menu had already
     * been dismissed.
     */
    protected class RecordingTextContextMenu : TextContextMenuProvider {
        var components: List<TextContextMenuComponent> = emptyList()
            private set

        fun item(key: Any): TextContextMenuItem? =
            components.filterIsInstance<TextContextMenuItem>().firstOrNull { it.key == key }

        override suspend fun showTextContextMenu(dataProvider: TextContextMenuDataProvider) {
            components = dataProvider.data().components
            awaitCancellation()
        }
    }

    /** Invoking an item's action needs the session it would close; nothing here
     *  has a menu on screen to close. */
    protected object NoopSession : TextContextMenuSession {
        override fun close() = Unit
    }

    /** The plate, in a scrolling column: an assertion must not fail merely
     *  because this device's screen is shorter than the card. */
    protected fun showPlate(license: LicenseModel, localization: Localization) {
        compose.setContent {
            FutoNotesTheme(darkTheme = false) {
                CompositionLocalProvider(LocalLocalization provides localization) {
                    Column(Modifier.verticalScroll(rememberScrollState())) {
                        LicenseSettingsSection(license)
                    }
                }
            }
        }
    }

    protected fun licensedModel(): LicenseModel {
        val license = LicenseModel(LicenseStorage(preferences), LicenseFixture.DEV_APPLICATION_ID)
        license.showMessage = {}
        license.handle(LicenseFixture.deepLink)
        checkNotNull(license.view) { "the fixture link did not license the device" }
        return license
    }
}

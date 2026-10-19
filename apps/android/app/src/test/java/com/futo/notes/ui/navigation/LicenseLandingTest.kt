package com.futo.notes.ui.navigation

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Where an activation that includes the app icon lands (docs/spec/license.md
 * § Deep link, "Landing after activation"): decided once, at activation, and
 * never kept for a later Settings visit.
 */
class LicenseLandingTest {
    @Test fun fromTheListOrANoteOrSearchSettingsOpensAndTakesIt() {
        for (screen in listOf(RootFolder, Screen.Folder("a"), Screen.Editor("n.md", false), Screen.Search)) {
            assertEquals(screen.toString(), LicenseLanding.OPEN_SETTINGS, licenseLandingRoute(screen, modalUp = false))
        }
    }

    @Test fun settingsAlreadyUpTakesItInPlace() {
        assertEquals(LicenseLanding.SETTINGS_TAKES_IT, licenseLandingRoute(Screen.Settings, modalUp = false))
    }

    /** A screen Settings owns is the Android form of "a Settings-owned sheet is up". */
    @Test fun aScreenSettingsOwnsDropsIt() {
        for (screen in listOf(Screen.Sync, Screen.StorageLocation, Screen.Feedback)) {
            assertEquals(screen.toString(), LicenseLanding.DROP, licenseLandingRoute(screen, modalUp = false))
        }
    }

    @Test fun anotherModalOverTheShellDropsIt() {
        assertEquals(LicenseLanding.DROP, licenseLandingRoute(RootFolder, modalUp = true))
        assertEquals(LicenseLanding.DROP, licenseLandingRoute(Screen.Settings, modalUp = true))
    }
}

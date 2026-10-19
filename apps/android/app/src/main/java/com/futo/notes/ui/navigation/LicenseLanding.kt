package com.futo.notes.ui.navigation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import com.futo.notes.license.LicenseModel

/**
 * Where an activation that includes the app icon goes (docs/spec/license.md
 * § Deep link, "Landing after activation"). Decided once, at the moment of
 * activation: a landing that cannot be presented is dropped, never kept for a
 * later Settings visit.
 */
internal enum class LicenseLanding {
    /** Push Settings; it opens the picker with the landing header. */
    OPEN_SETTINGS,

    /** Settings is already showing and opens the picker itself. */
    SETTINGS_TAKES_IT,

    /** Something else is up: the toast alone is the landing. */
    DROP,
}

/**
 * [modalUp] is any dialog over the shell (the crash report). Sync, Storage
 * location and Feedback are screens Settings owns, so being on one is the
 * Android form of "a Settings-owned sheet is up".
 */
internal fun licenseLandingRoute(screen: Screen, modalUp: Boolean): LicenseLanding =
    if (modalUp) {
        LicenseLanding.DROP
    } else {
        when (screen) {
            Screen.Settings -> LicenseLanding.SETTINGS_TAKES_IT
            is Screen.Folder, is Screen.Editor, Screen.Search -> LicenseLanding.OPEN_SETTINGS
            Screen.Sync, Screen.StorageLocation, Screen.Feedback -> LicenseLanding.DROP
        }
    }

/**
 * Applies an activation's landing from the shell: Settings takes it itself once
 * it is showing; anything else up drops it on the spot, so it is never kept.
 */
@Composable
internal fun LicenseLandingEffect(license: LicenseModel, navigator: AppNavigator, modalUp: Boolean) {
    LaunchedEffect(license.pendingLanding) {
        if (!license.pendingLanding) return@LaunchedEffect
        when (licenseLandingRoute(navigator.currentScreen, modalUp)) {
            LicenseLanding.OPEN_SETTINGS -> navigator.openSettings()
            LicenseLanding.SETTINGS_TAKES_IT -> Unit
            LicenseLanding.DROP -> license.consumeLanding()
        }
    }
}

/**
 * With [noShell] (no vault surface to land in), the toast alone is the landing:
 * it is dropped rather than kept until the shell appears. A shell still loading
 * keeps it, and [LicenseLandingEffect] decides once it composes.
 */
@Composable
internal fun DropLicenseLandingWithoutShell(license: LicenseModel, noShell: Boolean) {
    LaunchedEffect(license.pendingLanding, noShell) {
        if (license.pendingLanding && noShell) license.consumeLanding()
    }
}

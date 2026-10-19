package com.futo.notes.ui.navigation

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

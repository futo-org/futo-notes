package com.futo.notes.ui.settings.appicon

import com.futo.notes.R
import uniffi.futo_notes_ffi.licenseAppIconsEveryInstallHas

enum class AppIcon(val id: String, val assetName: String, val preview: Int) {
    LIGHT_STANDARD("light-standard", "LightStandard", R.drawable.app_icon_light_standard),
    LIGHT_REVERSED("light-reversed", "LightReversed", R.drawable.app_icon_light_reversed),
    DARK_STANDARD("dark-standard", "DarkStandard", R.drawable.app_icon_dark_standard),
    DARK_REVERSED("dark-reversed", "DarkReversed", R.drawable.app_icon_dark_reversed),
    FUTO("futo", "Futo", R.drawable.app_icon_futo),
    WEBSITE("website", "Website", R.drawable.app_icon_website);

    val aliasName get() = "com.futo.notes.Launcher$assetName"
    val labelKey get() = "settings.appIcon.choices." + assetName.replaceFirstChar { it.lowercase() }
    val manifestEnabled get() = this == LIGHT_STANDARD

    companion object {
        /** The icons any install may choose, licensed or not. Rust owns the list. */
        fun everyInstallHas(): Set<AppIcon> =
            licenseAppIconsEveryInstallHas().mapNotNull { id -> entries.firstOrNull { it.id == id } }.toSet()
    }
}

package com.futo.notes.ui.settings.appicon

import uniffi.futo_notes_ffi.LicenseAction
import uniffi.futo_notes_ffi.LicenseInclusion

/**
 * What the picker puts on screen, before any of it is drawn.
 *
 * A pure function of the license's `includes` and Rust's `licenseRowActions`,
 * so the rendering is testable on the JVM and no storefront logic lives here:
 * whether the ask is link-out or key-only is only "does the row-action list
 * contain Buy or Renew" (docs/spec/settings.md § Native app icons). Mirrors iOS
 * `AppIconPickerShape`.
 */
data class AppIconPickerShape(
    /** Tiles wearing the coin. Never dimmed or disabled. */
    val coined: Set<AppIcon>,
    /** The one footnote under the grid — only while the license does not include icons. */
    val footnote: Boolean,
    /** What tapping a coined tile opens; `null` once the license includes icons. */
    val ask: Ask?,
    /**
     * False while the license is still being read: unknown is neither licensed
     * nor unlicensed, so no ask is drawn and a tap does nothing.
     */
    val resolved: Boolean = true,
) {
    sealed interface Ask {
        /** Buy (or Renew when Expired) is the filled button. */
        data class LinkOut(val primary: LicenseAction) : Ask

        /** Key-only builds: "I already paid" is the filled button, nothing else. */
        data object KeyOnly : Ask
    }

    /**
     * Key-only builds keep "included with a license": "unlocks" is for link-out
     * builds only (docs/spec/license.md § What a license includes).
     */
    val footnoteKey: String
        get() = if (ask == Ask.KeyOnly) {
            "settings.appIcon.license.footnoteKeyOnly"
        } else {
            "settings.appIcon.license.footnote"
        }

    /** Where a tap on [icon] goes: the ask, or the icon change. */
    fun asks(icon: AppIcon): Boolean = ask != null && icon in coined
}

fun appIconPickerShape(
    selected: AppIcon,
    includes: Set<LicenseInclusion>?,
    rowActions: List<LicenseAction>,
): AppIconPickerShape {
    if (includes == null) {
        return AppIconPickerShape(coined = emptySet(), footnote = false, ask = null, resolved = false)
    }
    if (LicenseInclusion.APP_ICON in includes) {
        // The coin stays on every icon but Standard, so the picker still shows
        // which ones came with the license.
        return AppIconPickerShape(
            coined = AppIcon.entries.toSet() - AppIcon.LIGHT_STANDARD,
            footnote = false,
            ask = null,
        )
    }
    val primary = rowActions.firstOrNull { it == LicenseAction.BUY || it == LicenseAction.RENEW }
    return AppIconPickerShape(
        coined = AppIcon.entries.toSet() - selected,
        footnote = true,
        ask = primary?.let { AppIconPickerShape.Ask.LinkOut(it) } ?: AppIconPickerShape.Ask.KeyOnly,
    )
}

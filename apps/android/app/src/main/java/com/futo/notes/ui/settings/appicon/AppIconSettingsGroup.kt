package com.futo.notes.ui.settings.appicon

import android.util.Log
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import com.futo.notes.browser.openInCustomTab
import com.futo.notes.license.LICENSE_LOG_TAG
import com.futo.notes.license.LicenseModel
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.ui.SettingsGroup
import com.futo.notes.ui.SettingsRow
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType
import kotlinx.coroutines.launch
import uniffi.futo_notes_ffi.LicenseInclusion

/**
 * The App icon group of Settings: the row (with the license hint) and the
 * picker it opens, including the landing after an activation (license.md
 * § Deep link). [landingBlocked] is a Settings dialog already up (Full reset):
 * the toast alone is then the landing.
 */
@Composable
internal fun AppIconSettingsGroup(
    controller: AppIconController,
    license: LicenseModel,
    landingBlocked: Boolean,
    onAlreadyPaid: () -> Unit,
) {
    val localization = LocalLocalization.current
    var showAppIcons by remember { mutableStateOf(false) }
    // The one-time header above the picker's grid after an activation. Set when
    // the landing opens the picker and dropped when it closes: nothing is
    // persisted, so reopening shows the plain grid.
    var showsLanding by remember { mutableStateOf(false) }

    // Taken now, whatever happens next: a landing is for the moment of
    // activation and is never kept for a later visit.
    LaunchedEffect(license.pendingLanding) {
        if (!license.pendingLanding) return@LaunchedEffect
        license.consumeLanding()
        if (landingBlocked) return@LaunchedEffect
        showsLanding = true
        // Already open (the user paid from its ask): it only gains the header.
        showAppIcons = true
    }

    SettingsGroup(localization.localizedText("settings.appIcon.heading")) {
        SettingsRow(
            title = localization.localizedText(controller.selected.labelKey),
            onClick = { showAppIcons = true },
            leading = {
                Image(painterResource(controller.selected.preview), null, Modifier.size(40.dp).clip(RoundedCornerShape(8.dp)))
            },
        ) {
            // Unknown (still loading) is not "unlicensed", so it says nothing.
            if (license.view != null && LicenseInclusion.APP_ICON !in license.includes) AppIconRowHint()
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = FutoTheme.colors.textMuted)
        }
    }

    if (showAppIcons) {
        AppIconPicker(controller, license, showsLanding, onAlreadyPaid = {
            showAppIcons = false
            showsLanding = false
            onAlreadyPaid()
        }) {
            showAppIcons = false
            showsLanding = false
        }
    }
}

/**
 * The coin and "More with a license" while the license does not include icons — on
 * key-only builds too: it names a fact, not a sale.
 */
@Composable
private fun AppIconRowHint() {
    CoinBadge(18.dp, ring = false)
    Spacer(Modifier.width(6.dp))
    Text(
        LocalLocalization.current.localizedText("settings.appIcon.license.rowHint"),
        style = FutoType.caption,
        color = FutoTheme.colors.textMuted,
    )
    Spacer(Modifier.width(4.dp))
}

/** [AppIconSheet] fed from the license: Rust's includes and row actions. */
@Composable
private fun AppIconPicker(
    controller: AppIconController,
    license: LicenseModel,
    showsLanding: Boolean,
    onAlreadyPaid: () -> Unit,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { controller.refresh() }
    val view = license.view
    val rowActions = remember(view) { license.actions() }
    AppIconSheet(
        controller,
        includes = view?.let { license.includes },
        rowActions = rowActions,
        surface = license.surface,
        website = license.links.website,
        showsLanding = showsLanding,
        onSelect = { icon -> scope.launch { controller.select(icon) } },
        onBuy = {
            runCatching { openInCustomTab(context, license.appIconLinks.buy) }
                .onFailure { Log.w(LICENSE_LOG_TAG, "nothing on this device opens checkout", it) }
        },
        onAlreadyPaid = onAlreadyPaid,
        onDismiss = onDismiss,
    )
}

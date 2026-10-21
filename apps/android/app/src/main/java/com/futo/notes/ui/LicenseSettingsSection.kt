package com.futo.notes.ui

import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import com.futo.notes.license.LICENSE_LOG_TAG
import com.futo.notes.browser.openInCustomTab
import com.futo.notes.license.LicenseCardModel
import com.futo.notes.license.LicenseModel
import com.futo.notes.license.licenseCardModel
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.localization.Localization
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType
import kotlinx.coroutines.launch
import uniffi.futo_notes_ffi.LicenseAction
import uniffi.futo_notes_ffi.LicensePurchaseSurface
import uniffi.futo_notes_ffi.LicenseStatus

/** The well is 184dp and the coin 160dp on every platform (D1/D5). It is
 *  unpainted space, not a drawn recess — @justin 2026-09-16 asked for the
 *  circle border gone on all three platforms, and on Android the inset-shadow
 *  ring WAS the whole well. Since 2026-09-18 the box itself is only reserved
 *  while Licensed: an empty circle read as something that had failed to load
 *  rather than as "no license". */
internal val WELL_DIAMETER = 184.dp

/** The plain-text sentence that names the website on `play`. */
internal const val LICENSE_WEBSITE_TAG = "license-website"
internal val COIN_DIAMETER = 160.dp

internal fun licenseExplanationPath(status: LicenseStatus, surface: LicensePurchaseSurface): String = when {
    status == LicenseStatus.LICENSED -> "license.explanationLicensed"
    surface == LicensePurchaseSurface.KEY_ONLY -> "license.keyOnlyExplanation"
    else -> "license.explanation"
}

/**
 * The sentence that names the website, or `null` where none is said: only a
 * [LicensePurchaseSurface.NAME_WEBSITE] build (`play`) that is not Licensed.
 */
internal fun licenseWebsitePath(status: LicenseStatus, surface: LicensePurchaseSurface): String? =
    if (status != LicenseStatus.LICENSED && surface == LicensePurchaseSurface.NAME_WEBSITE) {
        "license.websiteExplanation"
    } else {
        null
    }

/**
 * The License plate — the FIRST group of Settings on mobile, and the only place
 * a license is visible on this platform (docs/spec/license.md § States and copy).
 *
 * It follows the desktop plate, which moved twice in September 2026 and which
 * this shell was two rounds behind until 2026-09-18:
 *
 *   - **The well exists only while Licensed**, so the other two states reserve
 *     no 184dp box at all and the fields take the whole plate.
 *   - **Key is the whole ledger.** Nothing records a purchase date and nothing
 *     limits a license, so "Licensed since" and "Term" only ever said blank or
 *     "Perpetual". [licenseCardModel] still RETURNS both — it is shared law
 *     across the three shells (`license-card-copy`) and did not change; this
 *     screen simply stopped rendering them.
 *   - **Unlicensed has no letterhead.** The badge, the "Client license" eyebrow
 *     and the uppercase product name belong to a card, and Unlicensed has no
 *     card: it has an ask. The condition is "is there a stored key".
 *   - **Unlicensed leads with the ask**, with the reason ABOVE the one filled
 *     button rather than between it and the links — the shape Grayjay's Buy
 *     screen, FUTO Keyboard's Payment screen and Immich's purchase panel share.
 *   - **The plate is an ordinary Settings card** ([SettingsGroup]), not a
 *     gunmetal gradient of its own, which read as a foreign object in the sheet.
 *     Only the gold accent is still the plate's own.
 *
 * The coin turns, can be dragged, and a tap queues a turn — see [SupporterCoin].
 * Nothing else on the plate animates.
 *
 * Which controls each state offers is Rust's answer (`licenseRowActions` via
 * [LicenseModel.actions]), so Android and iOS render the same table and the
 * `licensePurchaseSurface` gives every shell the same storefront policy.
 */
@Composable
fun LicenseSettingsSection(
    license: LicenseModel,
    /** Bumped by the App icon picker's "I already paid": open the key field. */
    keyEntryRequest: Int = 0,
) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var entering by remember { mutableStateOf(false) }
    var draft by remember { mutableStateOf("") }

    // Null while the stored pair is still being read off the main thread (M1).
    // The plate keeps its shape and says nothing rather than flashing
    // "Unlicensed" at a licensed user for a frame.
    val view = license.view
    val card = view?.let { licenseCardModel(it, localization) }
    val licensed = card?.status == LicenseStatus.LICENSED

    // Revealing the key is view state and nothing else. `remember` keyed on the
    // stored key re-masks whenever the card goes away (leaving Settings) AND
    // whenever the key itself changes — Remove, or a new activation — so a
    // revealed key can never carry over into another license.
    var revealed by remember(view?.key) { mutableStateOf(false) }

    fun openMail(destination: String) {
        runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(destination))) }
            .onFailure { Log.w(LICENSE_LOG_TAG, "nothing on this device opens $destination", it) }
    }

    fun openBuy() {
        runCatching { openInCustomTab(context, license.links.buy) }
            .onFailure { Log.w(LICENSE_LOG_TAG, "nothing on this device opens checkout", it) }
    }

    fun cancelEntry() {
        entering = false
        draft = ""
    }

    fun submit() {
        // The one definition of "the field has something in it", so the
        // button's enabled state and this guard cannot disagree.
        if (draft.isBlank() || license.busy) return
        scope.launch { if (license.enterKey(draft)) cancelEntry() }
    }

    fun act(action: LicenseAction) {
        when (action) {
            LicenseAction.BUY, LicenseAction.RENEW -> openBuy()
            LicenseAction.LOST_KEY -> openMail(license.links.support)
            LicenseAction.ENTER_KEY -> {
                draft = ""
                entering = true
            }
            LicenseAction.REMOVE -> license.remove()
            // iOS only (ADR-0009); Rust never offers these to Android.
            LicenseAction.BUY_IN_APP_STORE, LicenseAction.RESTORE_PURCHASES -> Unit
        }
    }

    LaunchedEffect(keyEntryRequest) {
        if (opensKeyEntry(keyEntryRequest, license.view?.status)) act(LicenseAction.ENTER_KEY)
    }

    val actions = license.actions()
    val primaryAction =
        actions.firstOrNull { it == LicenseAction.BUY || it == LicenseAction.RENEW }
    val otherActions = actions.filter { it != primaryAction }

    // The state as one word, for assistive technology. It used to hang off the
    // well, and the well is now gone from two of the three states — so the
    // plate, which is always here, carries it. Licensed and Unlicensed have no
    // badge to borrow (the coin says one, the ask says the other), so each
    // reads its own catalog entry.
    val statusName = card?.let { licenseStatusName(it, localization) }

    // The same label + bordered card every other Settings group is built from:
    // the plate is one of the sheet's cards, not a slab of its own material.
    SettingsGroup(localization.localizedText("license.sectionTitle")) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 18.dp)
                .then(
                    if (statusName == null) {
                        Modifier
                    } else {
                        Modifier.semantics { stateDescription = statusName }
                    },
                ),
        ) {
            // A phone is narrower than the well plus a legible field column, so
            // the plate stacks where desktop puts them side by side — the same
            // re-flow desktop itself does below ~520px, taken as the only
            // layout here rather than as a breakpoint.
            if (licensed) {
                LicenseWell(localization.localizedText("license.coinAccessibilityLabel"))
                Spacer(Modifier.height(20.dp))
            }

            Column(Modifier.fillMaxWidth()) {
                if (card?.maskedKey != null) {
                    PlateLetterhead(card, storedKey = view?.key, revealed = revealed, onReveal = { revealed = true })
                } else if (card != null && license.surface != LicensePurchaseSurface.KEY_ONLY) {
                    Text(
                        localization.localizedText("license.unlicensedHeadline"),
                        style = FutoType.plateAsk,
                        color = c.textPrimary,
                    )
                }

                if (entering) {
                    LicenseKeyField(
                        draft = draft,
                        onDraft = { draft = it },
                        busy = license.busy,
                        onSubmit = ::submit,
                        onCancel = ::cancelEntry,
                    )
                } else if (card != null) {
                    PlateAsk(card, license.surface, license.links.website, primaryAction, onAct = ::act)
                }

                if (!entering) PlateLinks(otherActions, onAct = ::act)
            }
        }
    }
}

/** The state as one word, for assistive technology (see [LicenseSettingsSection]). */
private fun licenseStatusName(card: LicenseCardModel, localization: Localization): String = when (card.status) {
    LicenseStatus.LICENSED -> localization.localizedText("license.statusLicensed")
    else -> card.badge ?: localization.localizedText("license.unlicensed")
}

/** "I already paid" in the App icon picker opens the key field, unless already Licensed. */
private fun opensKeyEntry(request: Int, status: LicenseStatus?): Boolean =
    request > 0 && status != LicenseStatus.LICENSED

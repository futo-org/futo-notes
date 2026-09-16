package com.futo.notes.ui

import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import com.futo.notes.license.LICENSE_LOG_TAG
import com.futo.notes.license.LicenseCardModel
import com.futo.notes.license.LicenseModel
import com.futo.notes.license.catalogPath
import com.futo.notes.license.licenseCardModel
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.ui.components.MicroLabel
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType
import kotlinx.coroutines.launch
import uniffi.futo_notes_ffi.LicenseAction
import uniffi.futo_notes_ffi.LicenseStatus

/** The well is 184dp and the coin 160dp on every platform (D1/D5). The well is
 *  a reserved SPACE now, not a drawn recess — @justin 2026-09-16 asked for the
 *  circle border gone on all three platforms, and on Android the inset-shadow
 *  ring WAS the whole well, so nothing is painted here any more. */
private val WELL_DIAMETER = 184.dp
private val COIN_DIAMETER = 160.dp

/**
 * The License plate — the FIRST group of Settings on mobile, and the only place
 * the ambient "Unlicensed" label appears on this platform (docs/spec/license.md
 * § States and copy).
 *
 * One container, not a stack of rows: a gunmetal plate with a gold accent and a
 * circular well sunk into it, the same "Steel Ledger" card desktop and iOS draw
 * (docs/plan/license-ship.md D1). The well is there in every state; the static
 * supporter coin sits in it only when Licensed, and that — with the plate and
 * the label — is the whole reward. Nothing in the app is gated on a license.
 *
 * The coin turns, as it does on desktop — see [SupporterCoin], which projects
 * the same extruded disc rather than modelling it. Nothing else on the plate
 * animates.
 *
 * Which controls each state offers is Rust's answer (`licenseRowActions` via
 * [LicenseModel.actions]), so Android and iOS render the same table and the
 * `LICENSE_LINK_OUT` flag means the same thing on both.
 */
@Composable
fun LicenseSettingsSection(license: LicenseModel) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    var entering by remember { mutableStateOf(false) }
    var draft by remember { mutableStateOf("") }

    // Null while the stored pair is still being read off the main thread (M1).
    // The plate keeps its shape and says nothing rather than flashing
    // "Unlicensed" at a licensed user for a frame.
    val view = license.view
    val card = view?.let { licenseCardModel(it, localization) }

    // Revealing the key is view state and nothing else. `remember` keyed on the
    // stored key re-masks whenever the card goes away (leaving Settings) AND
    // whenever the key itself changes — Remove, or a new activation — so a
    // revealed key can never carry over into another license.
    var revealed by remember(view?.key) { mutableStateOf(false) }

    /** Buy, Renew and Lost-your-key all leave the app: an ACTION_VIEW intent
     *  hands the destination to the SYSTEM browser (or mail client), never an
     *  in-app WebView (docs/spec/license.md § Getting a license). */
    fun open(destination: String) {
        runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(destination))) }
            .onFailure { Log.w(LICENSE_LOG_TAG, "nothing on this device opens $destination", it) }
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
            LicenseAction.BUY, LicenseAction.RENEW -> open(license.links.buy)
            LicenseAction.LOST_KEY -> open(license.links.support)
            LicenseAction.ENTER_KEY -> {
                draft = ""
                entering = true
            }
            LicenseAction.REMOVE -> license.remove()
        }
    }

    val actions = license.actions()
    val primaryAction =
        actions.firstOrNull { it == LicenseAction.BUY || it == LicenseAction.RENEW }
    val otherActions = actions.filter { it != primaryAction }

    // The section label stays exactly where every other Settings group has it;
    // only the card underneath is made of different material.
    MicroLabel(
        localization.localizedText("license.sectionTitle"),
        Modifier.padding(start = 4.dp, top = 12.dp, bottom = 8.dp),
    )
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(FutoRadius.md))
            .background(Brush.verticalGradient(listOf(c.plateTop, c.plateBottom)))
            .padding(horizontal = 22.dp, vertical = 24.dp),
    ) {
        // A phone is narrower than the well plus a legible field column, so the
        // plate stacks where desktop puts them side by side — the same
        // re-flow desktop itself does below ~520px, taken as the only layout
        // here rather than as a breakpoint.
        LicenseWell(
            licensed = card?.status == LicenseStatus.LICENSED,
            // While the stored pair is still being read there is nothing
            // truthful to call the well: "No license" would be a claim (M1).
            label = when (card?.status) {
                null -> null
                LicenseStatus.LICENSED -> localization.localizedText("license.coinAccessibilityLabel")
                else -> localization.localizedText("license.card.emptyWell")
            },
        )
        Spacer(Modifier.height(20.dp))

        Column(Modifier.fillMaxWidth()) {
            card?.badge?.let { badge ->
                PlateBadge(badge)
                Spacer(Modifier.height(10.dp))
            }
            Text(
                localization.localizedText("license.card.eyebrow").uppercase(),
                style = FutoType.micro,
                color = c.plateAccent,
            )
            Text(
                localization.localizedText("license.card.productName").uppercase(),
                style = FutoType.plateName,
                color = c.plateInk,
            )

            if (card != null) {
                Spacer(Modifier.height(16.dp))
                PlateRule()
                PlateRow(localization.localizedText("license.card.keyLabel")) {
                    PlateKeyValue(
                        card = card,
                        storedKey = view?.key,
                        revealed = revealed,
                        onReveal = { revealed = true },
                        onCopy = { key ->
                            clipboard.setText(AnnotatedString(key))
                            license.announceKeyCopied()
                        },
                    )
                }
                PlateRule()
                // Present and blank for a v1 activation: nothing is invented to
                // fill it (D2).
                PlateRow(localization.localizedText("license.card.sinceLabel")) {
                    PlateValue(card.since ?: "")
                }
                PlateRule()
                PlateRow(localization.localizedText("license.card.termLabel")) {
                    PlateValue(card.term)
                }
                PlateRule()
            }

            if (entering) {
                LicenseKeyField(
                    draft = draft,
                    onDraft = { draft = it },
                    busy = license.busy,
                    onSubmit = ::submit,
                    onCancel = ::cancelEntry,
                )
            } else if (primaryAction != null) {
                Spacer(Modifier.height(18.dp))
                // The ONE filled button on the plate, and it keeps the app's
                // own primary colour: the gold is for rules, the badge and the
                // plate's links, never a fill.
                Button(
                    onClick = { act(primaryAction) },
                    shape = RoundedCornerShape(FutoRadius.sm),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(localization.localizedText(primaryAction.catalogPath()))
                }
            }

            // In every state (docs/spec/license.md § States and copy). Never
            // "free to use": Unlicensed asks, Licensed thanks.
            Spacer(Modifier.height(16.dp))
            Text(
                localization.localizedText(
                    if (card?.status == LicenseStatus.LICENSED) {
                        "license.explanationLicensed"
                    } else {
                        "license.explanation"
                    },
                ),
                style = FutoType.caption,
                color = c.plateInkDim,
            )

            if (!entering && otherActions.isNotEmpty()) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    for (action in otherActions) {
                        PlateLink(
                            label = localization.localizedText(action.catalogPath()),
                            onClick = { act(action) },
                        )
                    }
                }
            }
        }
    }
}

/**
 * The well: a 184dp circular depression in the plate, present in EVERY state.
 *
 * It has no fill and no ring (D1) — the plate's own gradient shows through, and
 * only an inset shadow says it is sunk. Compose has no `box-shadow: inset`, so
 * the desktop plate's
 * `inset 0 2px 6px rgba(0,0,0,.28), inset 0 -1px 0 rgba(255,255,255,.35)`
 * is drawn inside the clipped circle as three passes: a rim darkening that is
 * transparent until ~70% of the radius (the 6px blur), a vertical cast under
 * the top edge (the 2px downward offset), and one hairline of light along the
 * bottom inside edge (the `-1px` highlight).
 */
@Composable
private fun LicenseWell(licensed: Boolean, label: String?) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .size(WELL_DIAMETER)
            .then(
                if (label == null) Modifier else Modifier.semantics { contentDescription = label },
            ),
    ) {
        if (licensed) {
            // The well carries the label; a second one on the coin would make it
            // a separate stop that says the same thing, so `SupporterCoin` is
            // undecorated.
            SupporterCoin(diameter = COIN_DIAMETER)
        }
    }
}

/** Unlicensed and Expired name themselves; Licensed wears no badge, because the
 *  coin in the well is the statement. */
@Composable
private fun PlateBadge(badge: String) {
    val c = FutoTheme.colors
    Surface(
        color = Color.Transparent,
        shape = RoundedCornerShape(FutoRadius.pill),
        border = BorderStroke(1.dp, c.plateAccent),
    ) {
        Text(
            badge.uppercase(),
            style = FutoType.micro,
            color = c.plateAccent,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
        )
    }
}

/** One hairline of the ledger. */
@Composable
private fun PlateRule() {
    HorizontalDivider(thickness = 1.dp, color = FutoTheme.colors.plateRule)
}

/**
 * One line of the plate's ledger: the label above its value, both at the
 * plate's full width.
 *
 * Desktop sets these as a two-column `dl` because its Settings pane is wide
 * enough. A phone is not: a 32-character masked key beside a label leaves under
 * 180dp for a monospace value, which wraps mid-group and reads like a mistake.
 * Stacking gives every value the whole plate and keeps all three rows the same
 * shape whatever a translation does to the labels.
 *
 * Every row is present in every state; a row with nothing to say renders blank
 * rather than disappearing, so the plate does not change shape when a license
 * arrives.
 */
@Composable
private fun PlateRow(label: String, value: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(top = 10.dp, bottom = 8.dp)) {
        Text(
            label.uppercase(),
            style = FutoType.micro,
            color = FutoTheme.colors.plateInkDim,
        )
        Spacer(Modifier.height(2.dp))
        value()
    }
}

@Composable
private fun PlateValue(value: String) {
    Text(value, style = FutoType.caption, color = FutoTheme.colors.plateInk)
}

/**
 * The stored key, masked to its last group until it is asked for (D4).
 *
 * Masking is the shared card model's (`licenseCardModel`); revealing and
 * copying are local UI and no rule at all — Rust neither knows nor cares that
 * the screen is showing the key.
 */
@Composable
private fun PlateKeyValue(
    card: LicenseCardModel,
    storedKey: String?,
    revealed: Boolean,
    onReveal: () -> Unit,
    onCopy: (String) -> Unit,
) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    val masked = card.maskedKey
    if (masked == null || storedKey == null) {
        // No license: the row is present and empty, like the since row.
        PlateValue("")
        return
    }
    if (!revealed) {
        TextButton(
            onClick = onReveal,
            contentPadding = PaddingValues(vertical = 4.dp),
            colors = ButtonDefaults.textButtonColors(contentColor = c.plateInk),
            // The masked value IS the control, so the button's accessible name
            // says what tapping it does rather than reading the dots aloud.
            modifier = Modifier.semantics {
                contentDescription = localization.localizedText("license.card.revealKey")
            },
        ) {
            Text(masked, style = FutoType.plateKey, color = c.plateInk)
        }
        return
    }
    Column {
        Text(storedKey, style = FutoType.plateKey, color = c.plateInk)
        TextButton(
            onClick = { onCopy(storedKey) },
            contentPadding = PaddingValues(vertical = 4.dp),
            colors = ButtonDefaults.textButtonColors(contentColor = c.plateAccent),
        ) {
            Text(
                localization.localizedText("license.card.copyKey"),
                style = FutoType.caption,
                color = c.plateAccent,
            )
        }
    }
}

/** Every control on the plate that is not the one filled button. */
@Composable
private fun PlateLink(label: String, onClick: () -> Unit) {
    val c = FutoTheme.colors
    TextButton(
        onClick = onClick,
        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
        colors = ButtonDefaults.textButtonColors(contentColor = c.plateAccent),
    ) {
        Text(label, style = FutoType.caption, color = c.plateAccent)
    }
}

/**
 * One text field for all three accepted shapes (a bare key, `key/activation`,
 * or a `futonotes://` link) — recognising which is Rust's job, not this view's.
 * A field with no submit is not operable, so Activate and Cancel come with it;
 * iOS and the desktop projection supply the same three controls.
 */
@Composable
private fun LicenseKeyField(
    draft: String,
    onDraft: (String) -> Unit,
    busy: Boolean,
    onSubmit: () -> Unit,
    onCancel: () -> Unit,
) {
    val localization = LocalLocalization.current
    Column(Modifier.padding(top = 12.dp)) {
        OutlinedTextField(
            value = draft,
            onValueChange = onDraft,
            label = { Text(localization.localizedText("license.keyLabel")) },
            placeholder = { Text(localization.localizedText("license.keyPlaceholder")) },
            singleLine = true,
            enabled = !busy,
            // A license key is not prose: an IME that autocapitalizes or
            // autocorrects it changes the bytes that get verified. The
            // activation half is base64url, where case is meaning.
            keyboardOptions = KeyboardOptions(
                autoCorrectEnabled = false,
                capitalization = KeyboardCapitalization.None,
                imeAction = ImeAction.Done,
            ),
            keyboardActions = KeyboardActions(onDone = { onSubmit() }),
            shape = RoundedCornerShape(FutoRadius.md),
            modifier = Modifier.fillMaxWidth(),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = onSubmit, enabled = !busy && draft.isNotBlank()) {
                Text(
                    if (busy) {
                        localization.localizedText("license.activating")
                    } else {
                        localization.localizedText("license.activate")
                    },
                )
            }
            TextButton(onClick = onCancel, enabled = !busy) {
                Text(localization.localizedText("license.cancelEntry"))
            }
        }
    }
}

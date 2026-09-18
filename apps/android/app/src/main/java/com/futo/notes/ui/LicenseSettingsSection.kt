package com.futo.notes.ui

import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import com.futo.notes.license.LICENSE_LOG_TAG
import com.futo.notes.license.LicenseCardModel
import com.futo.notes.license.LicenseModel
import com.futo.notes.license.catalogPath
import com.futo.notes.license.licenseCardModel
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType
import kotlinx.coroutines.launch
import uniffi.futo_notes_ffi.LicenseAction
import uniffi.futo_notes_ffi.LicenseStatus

/** The well is 184dp and the coin 160dp on every platform (D1/D5). It is
 *  unpainted space, not a drawn recess — @justin 2026-09-16 asked for the
 *  circle border gone on all three platforms, and on Android the inset-shadow
 *  ring WAS the whole well. Since 2026-09-18 the box itself is only reserved
 *  while Licensed: an empty circle read as something that had failed to load
 *  rather than as "no license". */
private val WELL_DIAMETER = 184.dp
private val COIN_DIAMETER = 160.dp

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
 * `LICENSE_LINK_OUT` flag means the same thing on both.
 */
@Composable
fun LicenseSettingsSection(license: LicenseModel) {
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

    // The state as one word, for assistive technology. It used to hang off the
    // well, and the well is now gone from two of the three states — so the
    // plate, which is always here, carries it. Licensed and Unlicensed have no
    // badge to borrow (the coin says one, the ask says the other), so each
    // reads its own catalog entry.
    val statusName = when (card?.status) {
        null -> null
        LicenseStatus.LICENSED -> localization.localizedText("license.statusLicensed")
        else -> card.badge ?: localization.localizedText("license.unlicensed")
    }

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
                    // The letterhead, and only where there is a card to put it
                    // on. Licensed wears no badge: the coin is the statement.
                    card.badge?.let { badge ->
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
                        color = c.textPrimary,
                    )

                    // Key is the whole ledger. One blank row would be the same
                    // void the empty well was, so with no key there is no
                    // ledger at all.
                    Spacer(Modifier.height(16.dp))
                    Text(
                        localization.localizedText("license.card.keyLabel").uppercase(),
                        style = FutoType.micro,
                        color = c.textMuted,
                    )
                    Spacer(Modifier.height(2.dp))
                    PlateKeyValue(
                        card = card,
                        storedKey = view?.key,
                        revealed = revealed,
                        onReveal = { revealed = true },
                    )
                } else if (card != null) {
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
                    Spacer(Modifier.height(14.dp))
                    // Never "free to use": Unlicensed and Expired ask, Licensed
                    // thanks. The mission paragraph is the ONLY paragraph, and
                    // it sits ABOVE the button it argues for — an argument
                    // printed under its own button is a footnote.
                    Text(
                        localization.localizedText(
                            if (licensed) "license.explanationLicensed" else "license.explanation",
                        ),
                        style = FutoType.caption,
                        color = c.textMuted,
                    )
                    if (primaryAction != null) {
                        Spacer(Modifier.height(16.dp))
                        // The ONE filled button on the plate, and it keeps the
                        // app's own primary colour: the gold is for the eyebrow,
                        // the badge and the plate's links, never a fill.
                        Button(
                            onClick = { act(primaryAction) },
                            shape = RoundedCornerShape(FutoRadius.sm),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(localization.localizedText(primaryAction.catalogPath()))
                        }
                    }
                }

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
}

/**
 * The well: 184dp of reserved space with the coin in it, and only while
 * Licensed.
 *
 * Nothing is painted here — no fill, no ring (D1). The box exists so the coin
 * has a size to fill and somewhere to hang its accessibility label.
 */
@Composable
private fun LicenseWell(label: String) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .size(WELL_DIAMETER)
            .semantics { contentDescription = label },
    ) {
        // The well carries the label; a second one on the coin would make it
        // a separate stop that says the same thing, so `SupporterCoin` is
        // undecorated.
        SupporterCoin(diameter = COIN_DIAMETER)
    }
}

/** Expired names itself; Licensed wears no badge, because the coin in the well
 *  is the statement, and Unlicensed has no card to wear one on. */
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

/**
 * The stored key, masked to its last group until it is asked for (D4).
 *
 * Masking is the shared card model's ([licenseCardModel]); revealing is local
 * UI and no rule at all — Rust neither knows nor cares that the screen is
 * showing the key. There is no Copy control: copying is a deliberate
 * press-and-copy, because a license key should not be one tap from the
 * clipboard (@justin 2026-09-17).
 *
 * Label above value: a 39-character key beside a label leaves under 180dp for a
 * monospace value, which wraps mid-group and reads like a mistake.
 */
@Composable
private fun PlateKeyValue(
    card: LicenseCardModel,
    storedKey: String?,
    revealed: Boolean,
    onReveal: () -> Unit,
) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    val masked = card.maskedKey ?: return
    val shown = if (revealed && storedKey != null) storedKey else masked
    // ONE Text in both states, not a TextButton swapped for a Text. The button
    // carries a 40dp minimum height and its own content padding, so revealing
    // the key used to shorten the row and pull everything below it up the
    // screen. Only the STRING changes now, and because the mask is the key's
    // own length in a monospace face, the reveal is a glyph-for-glyph swap that
    // moves nothing at all (@justin 2026-09-18).
    Text(
        shown,
        style = FutoType.plateKey,
        color = c.textPrimary,
        modifier = Modifier
            .padding(vertical = 4.dp)
            .then(
                if (revealed && storedKey != null) {
                    Modifier
                } else {
                    // The masked value IS the control, so its accessible name
                    // says what tapping it does rather than reading the dots
                    // aloud.
                    Modifier
                        .clickable(onClick = onReveal)
                        .semantics {
                            contentDescription =
                                localization.localizedText("license.card.revealKey")
                        }
                },
            ),
    )
}

/** Every control on the plate that is not the one filled button. */
@Composable
private fun PlateLink(label: String, onClick: () -> Unit) {
    val c = FutoTheme.colors
    TextButton(
        onClick = onClick,
        // No horizontal content padding: TextButton's default 12dp (and the 8dp
        // this carried) indented every plate link relative to the eyebrow, the
        // key and the paragraph above them, so "Remove license" read as being
        // nested under the card rather than aligned to it. The row's own 16dp
        // is the plate's left edge and the only inset these want.
        contentPadding = PaddingValues(horizontal = 0.dp, vertical = 4.dp),
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

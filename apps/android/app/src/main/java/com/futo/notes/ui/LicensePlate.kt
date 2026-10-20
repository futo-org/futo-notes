package com.futo.notes.ui

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
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import com.futo.notes.license.LicenseCardModel
import com.futo.notes.license.catalogPath
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType
import uniffi.futo_notes_ffi.LicenseAction
import uniffi.futo_notes_ffi.LicensePurchaseSurface

/**
 * The letterhead, and only where there is a card to put it on. Licensed wears
 * no badge: the coin is the statement.
 */
@Composable
internal fun PlateLetterhead(card: LicenseCardModel, storedKey: String?, revealed: Boolean, onReveal: () -> Unit) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
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

    // Key is the whole ledger. One blank row would be the same void the empty
    // well was, so with no key there is no ledger at all.
    Spacer(Modifier.height(16.dp))
    Text(
        localization.localizedText("license.card.keyLabel").uppercase(),
        style = FutoType.micro,
        color = c.textMuted,
    )
    Spacer(Modifier.height(2.dp))
    PlateKeyValue(card = card, storedKey = storedKey, revealed = revealed, onReveal = onReveal)
}

/**
 * Never "free to use": Unlicensed and Expired ask, Licensed thanks. The mission
 * paragraph is the ONLY paragraph, and it sits ABOVE the button it argues for —
 * an argument printed under its own button is a footnote.
 */
@Composable
internal fun PlateAsk(
    card: LicenseCardModel,
    surface: LicensePurchaseSurface,
    website: String,
    primaryAction: LicenseAction?,
    onAct: (LicenseAction) -> Unit,
) {
    val localization = LocalLocalization.current
    Spacer(Modifier.height(14.dp))
    Text(
        localization.localizedText(licenseExplanationPath(card.status, surface)),
        style = FutoType.caption,
        color = FutoTheme.colors.textMuted,
    )
    licenseWebsitePath(card.status, surface)?.let { path ->
        Spacer(Modifier.height(8.dp))
        // Names the website and nothing more: plain text, no link, no copy
        // button (Google Play's consumption-only rule, docs/spec/license.md
        // § Store posture).
        Text(
            localization.localizedText(path, mapOf("url" to website)),
            style = FutoType.caption,
            color = FutoTheme.colors.textMuted,
            modifier = Modifier.testTag(LICENSE_WEBSITE_TAG),
        )
    }
    if (primaryAction != null) {
        Spacer(Modifier.height(16.dp))
        // The ONE filled button on the plate, and it keeps the app's own
        // primary colour: the gold is for the eyebrow, the badge and the
        // plate's links, never a fill.
        Button(
            onClick = { onAct(primaryAction) },
            shape = RoundedCornerShape(FutoRadius.sm),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(localization.localizedText(primaryAction.catalogPath()))
        }
    }
}

/** Every control on the plate that is not the one filled button, in Rust's order. */
@Composable
internal fun PlateLinks(actions: List<LicenseAction>, onAct: (LicenseAction) -> Unit) {
    if (actions.isEmpty()) return
    val localization = LocalLocalization.current
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.fillMaxWidth()) {
        for (action in actions) {
            PlateLink(label = localization.localizedText(action.catalogPath()), onClick = { onAct(action) })
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
internal fun LicenseWell(label: String) {
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
 * clipboard (@justin 2026-09-17) — which is why the revealed key sits in a
 * [SelectionContainer]. Compose text is not selectable without one, so until
 * 2026-09-19 that sentence described nothing: the 42 characters a buyer has to
 * get off the phone could only be transcribed by hand.
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
    val localization = LocalLocalization.current
    val masked = card.maskedKey ?: return
    // ONE Text in both states, not a TextButton swapped for a Text. The button
    // carries a 40dp minimum height and its own content padding, so revealing
    // the key used to shorten the row and pull everything below it up the
    // screen. Only the STRING changes now, and because the mask is the key's
    // own length in a monospace face, the reveal is a glyph-for-glyph swap that
    // moves nothing at all (@justin 2026-09-18) — a `SelectionContainer` is a
    // `Box` around one child, so it measures to the Text and moves nothing
    // either (`revealingTheKeyMovesNothingOnThePlate` holds that).
    if (revealed && storedKey != null) {
        SelectionContainer { PlateKeyText(storedKey, Modifier) }
    } else {
        // The masked value IS the control, so it stays unselectable and its
        // accessible name says what tapping it does rather than reading the
        // dots aloud.
        PlateKeyText(
            masked,
            Modifier
                .clickable(onClick = onReveal)
                .semantics {
                    contentDescription = localization.localizedText("license.card.revealKey")
                },
        )
    }
}

@Composable
private fun PlateKeyText(shown: String, modifier: Modifier) {
    Text(
        shown,
        style = FutoType.plateKey,
        color = FutoTheme.colors.textPrimary,
        modifier = Modifier.padding(vertical = 4.dp).then(modifier),
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
internal fun LicenseKeyField(
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

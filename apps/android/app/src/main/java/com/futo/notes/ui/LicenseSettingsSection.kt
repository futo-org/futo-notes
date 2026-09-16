package com.futo.notes.ui

import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import com.futo.notes.license.LICENSE_LOG_TAG
import com.futo.notes.license.LicenseModel
import com.futo.notes.license.catalogPath
import com.futo.notes.license.licenseRowText
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType
import kotlinx.coroutines.launch
import uniffi.futo_notes_ffi.LicenseAction
import uniffi.futo_notes_ffi.LicenseStatus

/**
 * The License row — the FIRST row of Settings on mobile, and the only place the
 * ambient "Unlicensed" label appears on this platform (docs/spec/license.md
 * § States and copy).
 *
 * Nothing in the app is gated on a license: this row is the only difference a
 * purchase makes. Which controls each state offers is Rust's answer
 * (`licenseRowActions`), so Android and iOS render the same table and the
 * `LICENSE_LINK_OUT` flag means the same thing on both.
 */
@Composable
fun LicenseSettingsSection(license: LicenseModel) {
    val localization = LocalLocalization.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var entering by remember { mutableStateOf(false) }
    var draft by remember { mutableStateOf("") }

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

    SettingsGroup(localization.localizedText("license.sectionTitle")) {
        // Null while the stored pair is still being read off the main thread
        // (M1). The section keeps its shape and says nothing rather than
        // flashing "Unlicensed" at a licensed user for a frame.
        license.view?.let { view ->
            SettingsRow(title = licenseRowText(view, localization))

            if (entering) {
                Divider()
                LicenseKeyField(
                    draft = draft,
                    onDraft = { draft = it },
                    busy = license.busy,
                    onSubmit = ::submit,
                    onCancel = ::cancelEntry,
                )
            } else {
                for (action in license.actions()) {
                    Divider()
                    SettingsRow(
                        title = localization.localizedText(action.catalogPath()),
                        onClick = {
                            when (action) {
                                LicenseAction.BUY, LicenseAction.RENEW -> open(license.links.buy)
                                LicenseAction.LOST_KEY -> open(license.links.support)
                                LicenseAction.ENTER_KEY -> {
                                    draft = ""
                                    entering = true
                                }
                                LicenseAction.REMOVE -> license.remove()
                            }
                        },
                    )
                }
            }
        }

        // Under the row in every state (docs/spec/license.md § States and copy).
        // The rule above it belongs to the row, so it is not drawn before the
        // row exists — a group that opened with a stray divider.
        if (license.view != null) Divider()
        // Never "free to use": Unlicensed asks, Licensed thanks.
        Text(
            localization.localizedText(
                if (license.view?.status == LicenseStatus.LICENSED) {
                    "license.explanationLicensed"
                } else {
                    "license.explanation"
                }
            ),
            style = FutoType.caption,
            color = FutoTheme.colors.textMuted,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
        )
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
    Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
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


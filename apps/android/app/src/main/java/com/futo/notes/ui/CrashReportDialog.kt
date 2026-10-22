package com.futo.notes.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.futo.notes.puppet.PuppetVerb
import com.futo.notes.puppet.PuppetVerbScope
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.ui.components.ClearFocusOnImeDismiss
import com.futo.notes.ui.components.imeTargetVisible
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType

/**
 * Crash Report dialog [app.md:61, settings.md:43] — the Android counterpart of
 * the desktop crash dialog (App.svelte): expandable raw report, an optional
 * "What were you doing?" note, an always-send opt-in, Send / Don't Send.
 * "Don't Send" is the desktop-parity permanent opt-out (handled by the caller).
 */
@Composable
fun CrashReportDialog(
    reportJson: String,
    onSend: (userNote: String?, alwaysSend: Boolean) -> Unit,
    onDontSend: () -> Unit,
) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    // Read here (activity window) — the dialog window's insets lie (github#23).
    val imeVisible = imeTargetVisible()
    var showReport by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf("") }
    var always by remember { mutableStateOf(false) }

    // The dialog's own controls, so a crash can be answered without a tap.
    PuppetVerbScope(modal = true) {
        listOf(
            PuppetVerb(
                "SetCrashDescription",
                required = listOf("text"),
                controls = listOf("crashReporting.activityPromptOptional"),
            ) { arguments ->
                note = arguments.getString("text")
                mapOf("text" to note)
            },
            PuppetVerb(
                "SetAlwaysSendCrashReports",
                required = listOf("enabled"),
                booleans = listOf("enabled"),
                controls = listOf("crashReporting.sendAutomatically"),
            ) { arguments -> always = arguments.getBoolean("enabled"); mapOf("alwaysSend" to always) },
            PuppetVerb(
                "ToggleCrashDetails",
                controls = listOf("crashReporting.viewReport", "crashReporting.hideReport"),
            ) { showReport = !showReport; mapOf("open" to showReport) },
            PuppetVerb(
                "SendCrashReport",
                controls = listOf("common.actions.send"),
            ) { onSend(note.trim().ifEmpty { null }, always) },
            PuppetVerb("DiscardCrashReport", controls = listOf("crashReporting.dontSend")) { onDontSend() },
        )
    }

    AlertDialog(
        onDismissRequest = onDontSend,
        containerColor = c.surface,
        title = {
            Text(
                localization.localizedText("crashReporting.heading"),
                style = FutoType.title,
                color = c.textPrimary,
            )
        },
        text = {
            Column {
                // The dialog is its own window — the app-root install (#24)
                // can't reach its focus manager.
                ClearFocusOnImeDismiss(imeVisible)
                Text(
                    localization.localizedText("crashReporting.prompt"),
                    style = FutoType.small,
                    color = c.textSecondary,
                )
                TextButton(onClick = { showReport = !showReport }) {
                    Text(
                        if (showReport) {
                            localization.localizedText("crashReporting.hideReport")
                        } else {
                            localization.localizedText("crashReporting.viewReport")
                        },
                        color = c.textAccent,
                    )
                }
                if (showReport) {
                    Surface(color = c.surfaceSunken, shape = RoundedCornerShape(FutoRadius.sm)) {
                        Box(
                            modifier = Modifier
                                .heightIn(max = 180.dp)
                                .verticalScroll(rememberScrollState()),
                        ) {
                            Text(
                                reportJson,
                                style = FutoType.caption.copy(fontFamily = FontFamily.Monospace),
                                color = c.textTertiary,
                                modifier = Modifier.padding(8.dp),
                            )
                        }
                    }
                }
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it },
                    label = {
                        Text(localization.localizedText("crashReporting.activityPromptOptional"))
                    },
                    shape = RoundedCornerShape(FutoRadius.md),
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                )
                // The whole row is the checkbox: a tap on its label ticks it.
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.toggleable(always, role = Role.Checkbox) { always = it },
                ) {
                    Checkbox(checked = always, onCheckedChange = null)
                    Text(
                        localization.localizedText("crashReporting.sendAutomatically"),
                        style = FutoType.small,
                        color = c.textSecondary,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onSend(note.trim().ifEmpty { null }, always) }) {
                Text(localization.localizedText("common.actions.send"), color = c.textAccent)
            }
        },
        dismissButton = {
            TextButton(onClick = onDontSend) {
                Text(localization.localizedText("crashReporting.dontSend"), color = c.textSecondary)
            }
        },
    )
}

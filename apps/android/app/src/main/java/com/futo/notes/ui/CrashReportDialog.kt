package com.futo.notes.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.futo.notes.ui.components.ClearFocusOnImeDismiss
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
    var showReport by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf("") }
    var always by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDontSend,
        containerColor = c.surface,
        title = { Text("Crash Report", style = FutoType.title, color = c.textPrimary) },
        text = {
            Column {
                // The dialog is its own window — the app-root install (#24)
                // can't reach its focus manager.
                ClearFocusOnImeDismiss()
                Text(
                    "FUTO Notes crashed last time it ran. Send the report so it can be fixed?",
                    style = FutoType.small,
                    color = c.textSecondary,
                )
                TextButton(onClick = { showReport = !showReport }) {
                    Text(if (showReport) "Hide report" else "View report", color = c.textAccent)
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
                    label = { Text("What were you doing? (optional)") },
                    shape = RoundedCornerShape(FutoRadius.md),
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = always, onCheckedChange = { always = it })
                    Text("Always send crash reports", style = FutoType.small, color = c.textSecondary)
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onSend(note.trim().ifEmpty { null }, always) }) {
                Text("Send", color = c.textAccent)
            }
        },
        dismissButton = {
            TextButton(onClick = onDontSend) { Text("Don't Send", color = c.textSecondary) }
        },
    )
}

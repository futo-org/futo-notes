package com.futo.notes.ui.components

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.lifecycleScope
import com.futo.notes.puppet.PuppetVerb
import com.futo.notes.puppet.PuppetVerbScope
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType
import kotlinx.coroutines.launch

/**
 * Destructive confirm dialog [list.md] — Cancel + a danger-colored confirm
 * action. Shared by note delete (list row + editor menu) and folder delete.
 * [confirmLabelKey] is the confirm button's catalog key, so its row reads `→ ConfirmDialog`.
 * [onConfirm] is the whole act: the `ConfirmDialog` verb answers once it has finished, so its
 * receipt shows what confirming did; a tap runs it in the screen's lifecycle, past the dialog.
 */
@Composable
fun ConfirmDialog(
    title: String,
    body: String,
    confirmLabelKey: String,
    onConfirm: suspend () -> Unit,
    onDismiss: () -> Unit,
    destructive: Boolean = true,
) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    val lifecycleScope = LocalLifecycleOwner.current.lifecycleScope
    // While it is up it is all a person can reach.
    PuppetVerbScope(modal = true) {
        listOf(
            PuppetVerb("ConfirmDialog", controls = listOf(confirmLabelKey)) {
                onConfirm()
            },
            PuppetVerb("DismissDialog", controls = listOf("common.actions.cancel")) {
                onDismiss()
            },
        )
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.surface,
        title = { Text(title, style = FutoType.title, color = c.textPrimary) },
        text = { Text(body, style = FutoType.body, color = c.textSecondary) },
        confirmButton = {
            TextButton(onClick = { lifecycleScope.launch { onConfirm() } }) { Text(localization.localizedText(confirmLabelKey), color = if (destructive) c.danger else c.accent) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(localization.localizedText("common.actions.cancel"), color = c.textSecondary)
            }
        },
    )
}

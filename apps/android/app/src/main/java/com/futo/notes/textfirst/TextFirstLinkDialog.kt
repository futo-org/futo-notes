package com.futo.notes.textfirst

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.puppet.PuppetVerb
import com.futo.notes.puppet.PuppetVerbScope
import com.futo.notes.ui.theme.FutoTheme
import kotlinx.coroutines.launch

/** Local form state only. Interpretation, acceptance, escaping and Undo belong to Rust. */
@Composable
internal fun TextFirstLinkDialog(
    draft: LinkDraft,
    onSubmit: suspend (String, String) -> Boolean,
    onRemove: suspend () -> Boolean,
    onDismiss: () -> Unit,
) {
    val localization = LocalLocalization.current
    val c = FutoTheme.colors
    val scope = rememberCoroutineScope()
    var label by remember(draft) { mutableStateOf(draft.label) }
    var destination by remember(draft) { mutableStateOf(draft.destination) }
    val labelFocus = remember { FocusRequester() }
    val destinationFocus = remember { FocusRequester() }
    LaunchedEffect(draft) {
        if (draft.label.isEmpty()) labelFocus.requestFocus() else destinationFocus.requestFocus()
    }
    var busy by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    suspend fun apply(remove: Boolean = false) {
        if (busy || (!remove && (label.isEmpty() || destination.isEmpty()))) return
        busy = true
        val accepted = try {
            if (remove) onRemove() else onSubmit(label, destination)
        } finally { busy = false }
        if (accepted) onDismiss() else failed = true
    }
    PuppetVerbScope(modal = true) {
        buildList {
            add(PuppetVerb("SetLinkLabel", required = listOf("label"), controls = listOf("editor.linkPrompt.label")) {
                if (!busy) label = it.getString("label")
            })
            add(PuppetVerb("SetLinkDestination", required = listOf("destination"), controls = listOf("editor.linkPrompt.urlAccessibilityLabel")) {
                if (!busy) destination = it.getString("destination")
            })
            if (!busy && label.isNotEmpty() && destination.isNotEmpty()) {
                add(PuppetVerb("SubmitLink", controls = listOf("editor.linkPrompt.add", "editor.linkPrompt.update")) { apply() })
            }
            if (draft.existing && !busy) add(PuppetVerb("RemoveLink", controls = listOf("editor.linkPrompt.remove")) { apply(remove = true) })
            add(PuppetVerb("DismissLink", controls = listOf("common.actions.cancel")) { if (!busy) onDismiss() })
        }
    }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        containerColor = c.surface,
        title = { Text(localization.localizedText(if (draft.existing) "editor.selectionToolbar.editLink" else "editor.toolbar.link"), color = c.textPrimary) },
        text = {
            Column {
                OutlinedTextField(modifier = Modifier.focusRequester(labelFocus), value = label, onValueChange = { label = it }, enabled = !busy,
                    singleLine = true, label = { Text(localization.localizedText("editor.linkPrompt.label")) })
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(modifier = Modifier.focusRequester(destinationFocus), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), value = destination, onValueChange = { destination = it }, enabled = !busy,
                    singleLine = true, label = { Text(localization.localizedText("editor.linkPrompt.urlAccessibilityLabel")) })
                if (failed) Text(localization.localizedText("editor.linkPrompt.failed"), color = c.danger)
                if (draft.existing) TextButton(enabled = !busy, onClick = { scope.launch { apply(remove = true) } }) {
                    Text(localization.localizedText("editor.linkPrompt.remove"), color = c.danger)
                }
            }
        },
        confirmButton = {
            TextButton(enabled = !busy && label.isNotEmpty() && destination.isNotEmpty(), onClick = { scope.launch { apply() } }) {
                Text(if (draft.existing) localization.localizedText("editor.linkPrompt.update") else localization.localizedText("editor.linkPrompt.add"), color = c.accent)
            }
        },
        dismissButton = {
            TextButton(enabled = !busy, onClick = onDismiss) { Text(localization.localizedText("common.actions.cancel"), color = c.textSecondary) }
        },
    )
}

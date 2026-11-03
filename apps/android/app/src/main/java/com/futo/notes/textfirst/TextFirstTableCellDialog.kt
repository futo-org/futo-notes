package com.futo.notes.textfirst

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.puppet.PuppetHostedField
import com.futo.notes.puppet.PuppetVerb
import com.futo.notes.puppet.PuppetVerbScope
import com.futo.notes.puppet.puppetHostedField
import com.futo.notes.ui.theme.FutoTheme

@Composable
internal fun TextFirstTableCellDialog(controller: TextFirstController, field: TableCellEditText) {
    val localization = LocalLocalization.current
    val colors = FutoTheme.colors
    PuppetVerbScope(modal = true) { listOf(
        PuppetVerb("FinishTableCell", controls = listOf("common.actions.done")) { controller.finishCellEditing() },
        PuppetVerb("Undo", controls = listOf("editor.toolbar.undo")) { controller.undo() },
    ) }
    LaunchedEffect(field) {
        field.requestFocus()
        field.context.getSystemService(android.view.inputmethod.InputMethodManager::class.java).showSoftInput(field, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
    }
    AlertDialog(
        onDismissRequest = controller::finishCellEditing,
        containerColor = colors.surface,
        title = { Text(localization.localizedText("editor.table.editCell"), color = colors.textPrimary) },
        text = { Column {
            AndroidView(factory = { field }, modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp, max = 180.dp)
                .puppetHostedField { PuppetHostedField(field.text.toString(), localization.localizedText("editor.table.editCell"), field.isFocused) })
            TextButton(onClick = controller::undo) { Text(localization.localizedText("editor.toolbar.undo"), color = colors.accent) }
        } },
        confirmButton = { TextButton(onClick = controller::finishCellEditing) { Text(localization.localizedText("common.actions.done"), color = colors.accent) } },
    )
}

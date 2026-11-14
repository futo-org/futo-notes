package com.futo.notes.textfirst

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.puppet.PuppetVerb
import com.futo.notes.puppet.PuppetVerbScope
import com.futo.notes.ui.theme.FutoTheme

/** Cell-mode controls remain reachable beside the keyboard, without taking the note's window. */
@Composable
internal fun TextFirstTableCellControls(controller: TextFirstController) {
    val localization = LocalLocalization.current
    val colors = FutoTheme.colors
    PuppetVerbScope { listOf(
        PuppetVerb("FinishTableCell", controls = listOf("common.actions.done")) { controller.finishCellEditing() },
        PuppetVerb("Undo", controls = listOf("editor.toolbar.undo")) { controller.undo() },
    ) }
    Row(Modifier.fillMaxWidth()) {
        TextButton(onClick = controller::undo) { Text(localization.localizedText("editor.toolbar.undo"), color = colors.accent) }
        TextButton(onClick = controller::finishCellEditing) { Text(localization.localizedText("common.actions.done"), color = colors.accent) }
    }
}

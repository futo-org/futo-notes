package com.futo.notes.textfirst

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.puppet.PuppetHostedField
import com.futo.notes.puppet.puppetHostedField

/** Read the real hosted field's value/focus; input still goes through Android. */
@Composable
internal fun Modifier.nativeEditorField(controller: TextFirstController): Modifier {
    val text = LocalLocalization.current
    return puppetHostedField {
        PuppetHostedField(controller.view.text.toString(),
            text.localizedText("editor.toolbar.paragraph"), controller.view.isFocused)
    }
}

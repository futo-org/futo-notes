package com.futo.notes.textfirst

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.puppet.PuppetVerb
import com.futo.notes.puppet.PuppetVerbScope
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType

/** Persistent save feedback leaves the editor available while the user decides. */
@Composable
internal fun TextFirstSaveError(onRetry: suspend () -> Unit, onDiscard: () -> Unit) {
    val localization = LocalLocalization.current
    val colors = FutoTheme.colors
    val lifecycleScope = LocalLifecycleOwner.current.lifecycleScope
    PuppetVerbScope {
        listOf(
            PuppetVerb("RetrySave", controls = listOf("notes.save.retry")) { onRetry() },
            PuppetVerb("DiscardEdits", controls = listOf("notes.save.discard")) { onDiscard() },
        )
    }
    Column(Modifier.padding(horizontal = 22.dp)) {
        Text(localization.localizedText("notes.save.failedPending"), color = colors.danger, style = FutoType.caption)
        Row {
            TextButton(onClick = { lifecycleScope.launch { onRetry() } }) { Text(localization.localizedText("notes.save.retry")) }
            TextButton(onClick = onDiscard) { Text(localization.localizedText("notes.save.discard"), color = colors.danger) }
        }
    }
}

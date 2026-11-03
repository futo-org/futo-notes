package com.futo.notes.textfirst

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.puppet.PuppetVerb
import com.futo.notes.puppet.PuppetVerbRefusal
import com.futo.notes.puppet.PuppetVerbScope
import com.futo.notes.ui.theme.FutoTheme
import kotlinx.coroutines.launch

/** Inline, so opening suggestions never moves focus away from the input connection. */
@Composable
internal fun TextFirstCompletions(controller: TextFirstController) {
    val draft = controller.completion?.takeIf { controller.focused && it.value.candidates.isNotEmpty() } ?: return
    val scope = rememberCoroutineScope()
    val localization = LocalLocalization.current
    val colors = FutoTheme.colors
    val list = rememberLazyListState()
    suspend fun choose(noteId: String) {
        if (list.layoutInfo.visibleItemsInfo.none { it.key == noteId }) {
            throw PuppetVerbRefusal(409, "Scroll the completion list until the chosen note is visible")
        }
        if (!controller.acceptCompletion(draft, noteId)) throw PuppetVerbRefusal(409, "Completion changed; read the current suggestions")
    }
    PuppetVerbScope {
        listOf(
            PuppetVerb("AcceptWikilinkCompletion", required = listOf("noteId")) { choose(it.getString("noteId")) },
            PuppetVerb("DismissWikilinkCompletion", controls = listOf("common.actions.close")) { controller.dismissCompletion(draft) },
        )
    }
    Row(Modifier.fillMaxWidth()) {
        LazyColumn(Modifier.weight(1f).heightIn(max = 144.dp), state = list) {
            items(draft.value.candidates, key = { it.noteId }) { candidate ->
                Column(Modifier.fillMaxWidth().clickable {
                    scope.launch { controller.acceptCompletion(draft, candidate.noteId) }
                }.padding(horizontal = 16.dp, vertical = 8.dp)) {
                    Text(candidate.label, color = colors.textPrimary)
                    candidate.detail?.let { Text(it, color = colors.textSecondary) }
                }
            }
        }
        TextButton(onClick = { controller.dismissCompletion(draft) }) {
            Text(localization.localizedText("common.actions.close"), color = colors.textSecondary)
        }
    }
}

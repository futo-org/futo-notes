package com.futo.notes.textfirst

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.background
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import android.view.KeyEvent
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
    // The row a hardware keyboard's Enter or Tab takes (desktop's completion keys); a tap takes any row.
    var highlighted by remember(draft) { mutableIntStateOf(0) }
    DisposableEffect(controller) {
        // The hook can run after the engine replaced the list and before this composable redraws: it reads the
        // current list and keeps the row inside it.
        controller.view.keyHooks.completion = hook@{ keyCode ->
            val current = controller.completion?.takeIf { controller.focused } ?: return@hook false
            val count = current.value.candidates.size
            if (count == 0) return@hook false
            val row = highlighted.coerceIn(0, count - 1)
            when (keyCode) {
                KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_UP -> {
                    highlighted = if (keyCode == KeyEvent.KEYCODE_DPAD_DOWN) (row + 1) % count else (row + count - 1) % count
                    scope.launch { list.animateScrollToItem(highlighted) }
                }
                KeyEvent.KEYCODE_ESCAPE -> controller.dismissCompletion(current)
                else -> scope.launch { controller.acceptCompletion(current, current.value.candidates[row].noteId) }
            }
            true
        }
        onDispose { controller.view.keyHooks.completion = null }
    }
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
            itemsIndexed(draft.value.candidates, key = { _, it -> it.noteId }) { index, candidate ->
                Column(Modifier.fillMaxWidth().background(if (index == highlighted) colors.surfaceSunken else Color.Transparent).clickable {
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

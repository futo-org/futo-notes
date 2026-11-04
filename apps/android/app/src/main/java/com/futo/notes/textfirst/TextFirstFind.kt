package com.futo.notes.textfirst

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.futo.notes.localization.Localization
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.puppet.PuppetVerb
import com.futo.notes.puppet.PuppetVerbRefusal
import com.futo.notes.puppet.PuppetVerbScope
import com.futo.notes.ui.FindInNoteBar
import com.futo.notes.ui.canStepFind
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.focus.FocusManager
import androidx.compose.ui.platform.LocalFocusManager
import kotlinx.coroutines.CoroutineScope
import com.futo.notes.ui.theme.FutoTheme
import kotlinx.coroutines.launch

/** "2 of 5" from the shared catalog; plain "0" with no match. */
internal fun findLabel(localization: Localization, state: FindSnapshot?): String =
    localization.localizedText("editor.find.matchCount", mapOf("current" to (state?.current ?: 0), "total" to (state?.total ?: 0)))

/** `StepFind` for the note bar and the cell dialog: one direction contract, two targets. */
private fun stepFindVerb(step: suspend (forward: Boolean) -> Unit) = PuppetVerb(
    "StepFind", required = listOf("direction"), integers = listOf("direction"),
    controls = listOf("editor.find.previousMatch", "editor.find.nextMatch"),
) { arguments ->
    val direction = arguments.getInt("direction")
    if (direction != 1 && direction != -1) throw PuppetVerbRefusal(400, "direction is 1 (next) or -1 (previous)")
    step(direction == 1)
    mapOf("direction" to direction)
}

/**
 * Next/previous inside the table cell window: the cell dialog is modal, so the
 * bar below the note cannot be reached while a match is open in a cell.
 */
@Composable
internal fun TextFirstFindInCell(controller: TextFirstController) {
    val localization = LocalLocalization.current
    val colors = FutoTheme.colors
    val scope = rememberCoroutineScope()
    val state = controller.find
    val enabled = canStepFind(state?.total ?: 0)
    PuppetVerbScope(modal = true) {
        if (!enabled) emptyList() else listOf(
            stepFindVerb { controller.findStep(it) },
        )
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(findLabel(localization, state), color = colors.textSecondary)
        IconButton(enabled = enabled, onClick = { scope.launch { controller.findStep(false) } }, modifier = Modifier.size(48.dp)) {
            Icon(Icons.Filled.KeyboardArrowUp, localization.localizedText("editor.find.previousMatch"), tint = if (enabled) colors.textSecondary else colors.textMuted)
        }
        IconButton(enabled = enabled, onClick = { scope.launch { controller.findStep(true) } }, modifier = Modifier.size(48.dp)) {
            Icon(Icons.Filled.KeyboardArrowDown, localization.localizedText("editor.find.nextMatch"), tint = if (enabled) colors.textSecondary else colors.textMuted)
        }
    }
}

/** The note screen's find bar state: it drives the controller and holds only the typed query. */
internal class TextFirstFind(private val controller: TextFirstController, private val scope: CoroutineScope, private val focus: FocusManager) {
    var visible by mutableStateOf(false); private set
    var query by mutableStateOf(""); private set
    val state: FindSnapshot? get() = controller.find

    fun open() { visible = true; scope.launch { controller.findSetQuery(query) } }

    suspend fun setQuery(value: String) { query = value; controller.findSetQuery(value) }

    fun type(value: String) { scope.launch { setQuery(value) } }

    fun step(forward: Boolean) { scope.launch { controller.findStep(forward) } }

    fun close() {
        // Take the find field's keyboard down with the bar unless the note owns it.
        if (!controller.focused) focus.clearFocus(force = true)
        visible = false
        scope.launch { controller.findClose() }
    }
}

@Composable
internal fun rememberTextFirstFind(controller: TextFirstController, key: Any): TextFirstFind {
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    return remember(key) { TextFirstFind(controller, scope, focus) }
}

/** The find bar's verbs exist only while it is up, as on the WebView screen. */
@Composable
internal fun TextFirstFindVerbs(find: TextFirstFind, enabled: Boolean) {
    PuppetVerbScope {
        if (!find.visible || !enabled) return@PuppetVerbScope emptyList()
        buildList {
            add(PuppetVerb("SetFindQuery", optional = listOf("query")) { arguments ->
                find.setQuery(arguments.optString("query"))
                mapOf("query" to find.query)
            })
            if (canStepFind(find.state?.total ?: 0)) {
                add(stepFindVerb { find.step(it) })
            }
            add(PuppetVerb("CloseFind", controls = listOf("editor.find.close")) { find.close() })
        }
    }
}

@Composable
internal fun TextFirstFindBar(find: TextFirstFind) {
    if (!find.visible) return
    FindInNoteBar(
        query = find.query,
        label = findLabel(LocalLocalization.current, find.state),
        total = find.state?.total ?: 0,
        onQueryChange = find::type,
        onStep = { direction -> find.step(direction > 0) },
        onClose = find::close,
    )
}

package com.futo.notes.textfirst

import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
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
import kotlinx.coroutines.launch

/** "2 of 5" from the shared catalog; plain "0" with no match. */
internal fun findLabel(localization: Localization, state: FindSnapshot?): String =
    localization.localizedText("editor.find.matchCount", mapOf("current" to (state?.current ?: 0), "total" to (state?.total ?: 0)))

/** `StepFind` for the note bar. */
private fun stepFindVerb(step: suspend (forward: Boolean) -> Unit) = PuppetVerb(
    "StepFind", required = listOf("direction"), integers = listOf("direction"),
    controls = listOf("editor.find.previousMatch", "editor.find.nextMatch"),
) { arguments ->
    val direction = arguments.getInt("direction")
    if (direction != 1 && direction != -1) throw PuppetVerbRefusal(400, "direction is 1 (next) or -1 (previous)")
    step(direction == 1)
    mapOf("direction" to direction)
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
        // The note and its in-place cell share a window. Keep their input;
        // otherwise dismiss the query's IME before its native view is removed.
        if (!controller.view.isFocused && controller.cellView?.isFocused != true) {
            controller.view.hideKeyboard()
            focus.clearFocus(force = true)
        }
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

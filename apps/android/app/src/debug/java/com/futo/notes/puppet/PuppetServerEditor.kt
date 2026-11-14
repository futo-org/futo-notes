package com.futo.notes.puppet

import com.futo.notes.puppet.PuppetServer.Binding
import com.futo.notes.ui.navigation.Screen
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import kotlin.coroutines.resume

internal suspend fun forward(
    bound: Binding,
    command: String,
    argsJson: String,
): PuppetReply {
    val view = findNativeEditor(bound.shellView.rootView)
        ?: return PuppetContract.refusal(503, "native editor is not on screen")
    if (command == "do") {
        val request = JSONObject(argsJson)
        val args = request.optJSONObject("args") ?: JSONObject()
        when (val verb = request.getString("verb")) {
            "FocusEditor" -> {
                view.requestFocus()
                view.context.getSystemService(android.view.inputmethod.InputMethodManager::class.java)
                    .showSoftInput(view, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
            }
            "BlurEditor" -> {
                view.clearFocus()
                view.context.getSystemService(android.view.inputmethod.InputMethodManager::class.java)
                    .hideSoftInputFromWindow(view.windowToken, 0)
            }
            "Select" -> {
                val from = args.getInt("from")
                val to = args.optInt("to", from)
                if (from < 0 || to < from || to > (view.text?.length ?: 0))
                    return PuppetContract.refusal(409, "selection is outside the current native display")
                view.setSelection(from, to)
            }
            "Insert", "Type" -> {
                val input = view.onCreateInputConnection(android.view.inputmethod.EditorInfo())
                    ?: return PuppetContract.refusal(503, "native input connection unavailable")
                if (!input.commitText(args.getString("text"), 1))
                    return PuppetContract.refusal(409, "native input refused the edit")
            }
            else -> return PuppetContract.refusal(404, "unknown native editor verb: $verb")
        }
        return PuppetReply(200, JSONObject().put("ok", true).toString())
    }
    if (command == "actions") {
        val actions = org.json.JSONArray()
        for (name in listOf("FocusEditor", "BlurEditor", "Select", "Insert", "Type")) {
            actions.put(JSONObject().put("name", name).put("schema", PuppetContract.schema(emptyList())))
        }
        return PuppetReply(200, JSONObject().put("actions", actions).toString())
    }
    return PuppetContract.refusal(404, "unknown native editor query: $command")
}

/** The page's answer to [command] as an object, or null when it gave none. */
internal suspend fun forwardedObject(bound: Binding, command: String): JSONObject? {
    val forwarded = forward(bound, command, "{}")
    return if (forwarded.status == 200) runCatching { JSONObject(forwarded.body) }.getOrNull() else null
}

/** Off the editor, a name this screen did not register is another screen's verb or the editor's. */
internal fun requireOpenEditor(screen: Screen, action: String): PuppetReply? =
    if (screen is Screen.Editor) {
        null
    } else {
        PuppetContract.refusal(
            404,
            PuppetContract.offScreen(action, screen) +
                " (an editor verb needs an open editor; none is on the navigation stack)",
        )
    }

/**
 * The editor on top of the stack has read its note from disk and handed it to
 * the WebView — before that, a write would be overwritten by the load. Waits
 * up to three seconds; null when the editor is loaded or no note is open.
 */
internal suspend fun awaitEditorLoaded(bound: Binding, action: String): PuppetReply? {
    val screen = bound.navigator.currentScreen as? Screen.Editor ?: return null
    val deadline = System.nanoTime() + 3_000_000_000L
    while (PuppetVerbs.openNote == null || !PuppetVerbs.openNoteLoaded) {
        if (System.nanoTime() >= deadline) {
            return PuppetContract.refusal(
                503, "$action: the editor has not finished loading ${PuppetVerbs.openNote ?: screen.noteId}",
            )
        }
        delay(50)
    }
    // One more turn so the recomposition that pushes the body reaches the
    // WebView before the caller writes into it.
    delay(50)
    return null
}


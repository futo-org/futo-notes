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
    return PuppetContract.refusal(404, "native editor query unavailable: $command; use state or native input")
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


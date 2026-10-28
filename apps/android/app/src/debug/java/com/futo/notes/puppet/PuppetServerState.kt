package com.futo.notes.puppet

import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.findViewTreeLifecycleOwner
import com.futo.notes.flushPendingEditorAndWait
import com.futo.notes.puppet.PuppetServer.Binding
import com.futo.notes.ui.currentToast
import com.futo.notes.ui.navigation.Screen
import com.futo.notes.unsavedNoteIds
import kotlinx.coroutines.CancellationException
import org.json.JSONArray
import org.json.JSONObject

internal fun vault(bound: Binding, modified: Boolean = false): JSONObject = PuppetContract.vault(
    bound.store.notes.map { it.id },
    bound.store.folders,
    if (modified) bound.store.notes.associate { it.id to it.modifiedMs } else null,
)

/** The app's own search, best first — the engine the Search screen runs — for notes the vault still has. */
internal suspend fun search(bound: Binding, body: String): PuppetReply {
    val (query, limit) = PuppetContract.searchRequest(body)
        ?: return PuppetContract.refusal(
            400,
            "search needs {\"query\":\"…\"}, and \"limit\" if given is a positive whole number",
        )
    val known = bound.store.notes.map { it.id }.toSet()
    val hits = bound.store.search(query, limit).map { it.noteId }.filter { it in known }
    return PuppetReply(200, JSONObject().put("query", query).put("hits", JSONArray(hits)).toString())
}

/**
 * `file {"noteId", "save"?}`: the note's markdown as it is on disk, read once the open
 * editor's edits are written, so they are in it; refused while they are not on disk.
 * `"save":false` reads the disk as it is, writing nothing. The CLI narrows it to lines or
 * matches.
 */
internal suspend fun file(bound: Binding, body: String): PuppetReply {
    val request = arguments(body)
    val noteId = request.optString("noteId")
    if (noteId.isEmpty()) return PuppetContract.refusal(400, "file needs {\"noteId\":\"…\"}")
    if (request.optBoolean("save", true)) {
        bound.store.flushPendingEditorAndWait()
        if (noteId in bound.store.unsavedNoteIds()) {
            return PuppetContract.refusal(
                409,
                "\"$noteId\" has edits that did not save, so its file is not what the editor " +
                    "shows; \"save\":false reads the disk as it is",
            )
        }
    }
    // Only an id `notes` lists: a case-insensitive disk would read "Work/Retro" as
    // work/retro.
    val text = try {
        if (bound.store.notes.none { it.id == noteId }) null else bound.store.readIfExists(noteId)
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        return PuppetContract.refusal(500, "reading \"$noteId\" failed: ${e.message}")
    } ?: return PuppetContract.refusal(404, "no note \"$noteId\" in the vault; `notes` lists every one")
    return PuppetReply(200, JSONObject().put("noteId", noteId).put("text", text).toString())
}

/**
 * Everything a one-decision-per-turn controller needs in one call, the shape
 * `observe` has on desktop and iOS: the state, the vault, this screen's verbs and,
 * with the editor up, its document and rows. `futo-puppet step` is built on it.
 */
internal suspend fun observe(bound: Binding): PuppetReply {
    val reply = stateObject(bound)
    val vault = vault(bound)
    for (key in vault.keys()) reply.put(key, vault.get(key))
    reply.put("actions", actionsList(bound))
    reply.put("lines", JSONArray())
    reply.put("elements", JSONArray())
    if (bound.navigator.currentScreen is Screen.Editor) {
        forwardedObject(bound, "observe")?.let { page ->
            // The page owns the document and its rows; the shell owns the rest,
            // including which verbs this screen has.
            for (key in listOf("lines", "elements", "editor")) {
                if (page.has(key)) reply.put(key, page.get(key))
            }
        }
    }
    return PuppetReply(200, reply.toString())
}

/**
 * What a user sees: the screen, the search, the settings and sync values, and
 * — in the editor — the editor's own `state`, merged, so one call answers the
 * same questions it does on desktop and iOS.
 */
internal suspend fun stateObject(bound: Binding): JSONObject {
    val navigator = bound.navigator
    val prefs = bound.prefs
    val sync = bound.sync
    val screen = navigator.currentScreen
    val reply = JSONObject()
        .put("screen", PuppetContract.screen(screen, PuppetVerbs.openNote))
        // Every screen on the stack, root first, as `screen` names it: where each GoBack
        // leads, which futo-puppet counts to bring a row's folder on screen.
        .put(
            "stack",
            JSONArray(
                navigator.entries.mapIndexed { depth, entry ->
                    PuppetContract.screen(entry, PuppetVerbs.openNote.takeIf { depth == navigator.entries.lastIndex })
                },
            ),
        )
        // As stored, whole: a receipt shows any setting an action changes, picked or not.
        .put("settings", PuppetContract.storedSettings(prefs.all))
        .put(
            "sync",
            JSONObject()
                .put("connected", sync.connected)
                .put("live", sync.live)
                .put("status", sync.statusMessage.path)
                .put("lastError", sync.lastErrorDiagnostic ?: JSONObject.NULL),
        )
        // Work still in flight: an action whose receipt shows this has not finished yet.
        .put(
            "pending",
            JSONObject()
                .put("unsaved", JSONArray(bound.store.unsavedNoteIds()))
                .put("sync", sync.busy),
        )
        .put(
            "copied",
            PuppetVerbs.copied?.let { (count, text) -> JSONObject().put("count", count).put("text", text) }
                ?: JSONObject.NULL,
        )
        .put(
            "opened",
            PuppetVerbs.opened?.let { (count, url) -> JSONObject().put("count", count).put("url", url) }
                ?: JSONObject.NULL,
        )
        // The toast on screen, "" when none, as desktop reports it.
        .put("toast", currentToast)
        // Whether the app is on screen at all (system Back at the root leaves it), and
        // whether the keyboard is up: neither shows in the rows.
        .put(
            "foreground",
            // RESUMED, not STARTED: leaving pauses the activity at once, and it stays
            // started until its exit animation has run, after the receipt was taken.
            bound.shellView.findViewTreeLifecycleOwner()?.lifecycle?.currentState
                ?.isAtLeast(Lifecycle.State.RESUMED) == true,
        )
        .put(
            "keyboard",
            ViewCompat.getRootWindowInsets(bound.shellView)?.isVisible(WindowInsetsCompat.Type.ime()) == true,
        )
    if (screen == Screen.Search) {
        // The rows the screen shows; a blank query shows recent notes, which are no hits.
        val hits = if (navigator.searchQuery.isBlank()) emptyList() else PuppetVerbs.listRows(screen).orEmpty()
        reply.put(
            "search",
            JSONObject()
                .put("query", navigator.searchQuery)
                .put("hits", JSONArray(hits.map { it.substringAfter(':') })),
        )
    }
    if (screen is Screen.Editor) {
        forwardedObject(bound, "state")?.let { editor ->
            for (key in editor.keys()) if (!reply.has(key)) reply.put(key, editor.get(key))
        }
    }
    return reply
}

internal suspend fun actions(bound: Binding): PuppetReply = PuppetReply(
    200,
    JSONObject()
        .put("screen", PuppetContract.screen(bound.navigator.currentScreen, PuppetVerbs.openNote))
        .put("actions", actionsList(bound))
        .toString(),
)

private suspend fun actionsList(bound: Binding): JSONArray {
    val modal = PuppetVerbs.modalUp()
    val actions = if (modal) {
        JSONArray()
    } else {
        PuppetContract.nativeActions(bound.navigator.currentScreen, bound.navigator.canGoBack)
    }
    if (!modal && bound.navigator.currentScreen is Screen.Editor) {
        forwardedObject(bound, "actions")?.optJSONArray("actions")?.let { editorActions ->
            for (index in 0 until editorActions.length()) {
                actions.put(editorActions.get(index))
            }
        }
    }
    // The screens' own controls, from whatever is on top right now.
    for (verb in PuppetVerbs.all(bound.navigator.currentScreen)) actions.put(PuppetContract.actionEntry(verb))
    return actions
}

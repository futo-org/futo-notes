package com.futo.notes.puppet

import com.futo.notes.puppet.PuppetServer.Binding
import org.json.JSONObject

/** One verb the screen on top registered, its arguments checked like the shell's own. */
internal suspend fun screenVerb(verb: PuppetVerb, body: String): PuppetReply {
    val name = verb.name
    val arguments = arguments(body)
    for (key in verb.required) {
        val value = arguments.opt(key)
        val present = when (key) {
            in verb.integers -> value is Number
            in verb.booleans -> value is Boolean
            else -> (value as? String)?.isNotBlank() == true
        }
        if (!present) {
            val kind = when (key) {
                in verb.integers -> "an integer"
                in verb.booleans -> "a boolean"
                else -> "a non-empty string"
            }
            return PuppetContract.refusal(400, "$name requires $kind $key")
        }
    }
    return try {
        val receipt = JSONObject().put("ok", true).put("verb", name)
        (verb.run(arguments) as? Map<*, *>)?.forEach { (key, value) ->
            receipt.put(key.toString(), value ?: JSONObject.NULL)
        }
        PuppetReply(200, receipt.toString())
    } catch (refusal: PuppetVerbRefusal) {
        PuppetContract.refusal(refusal.status, refusal.message)
    } catch (error: Exception) {
        PuppetContract.refusal(500, "$name threw: $error")
    }
}

internal suspend fun nativeVerb(
    bound: Binding,
    name: String,
    body: String,
): PuppetReply {
    val arguments = arguments(body)
    val navigator = bound.navigator
    val store = bound.store

    fun text(key: String): String? =
        arguments.optString(key).trim().ifEmpty { null }

    fun required(key: String): String = text(key)
        ?: throw PuppetVerbRefusal(400, "$name requires a non-empty string $key")

    fun receipt(vararg extra: Pair<String, Any>): PuppetReply {
        val object_ = JSONObject().put("ok", true).put("verb", name)
        for ((key, value) in extra) object_.put(key, value)
        return PuppetReply(200, object_.toString())
    }

    /** A tap needs the row on screen: the current folder's content, or the current search results. */
    fun rowOnThisScreen(tag: String) {
        val rows = PuppetVerbs.listRows(navigator.currentScreen).orEmpty()
        rowRefusal(tag, rows, store.notes, store.folders)?.let { throw it }
    }

    return try {
        // GoBack IS the app's Back button: popping the stack runs the editor's
        // own exit (draft flush, title commit) through onDispose, as a tap does.
        if (name == "GoBack") {
            if (!navigator.canGoBack) {
                throw PuppetVerbRefusal(400, "navigation stack is already at the root")
            }
            navigator.goBack()
            return receipt()
        }
        // A verb the user has no control for on this screen.
        val offered = PuppetContract.nativeNames(navigator.currentScreen, navigator.canGoBack)
        if (name !in offered) {
            throw PuppetVerbRefusal(404, PuppetContract.offScreen(name, navigator.currentScreen))
        }
        if (!store.hasBootstrapped) {
            throw PuppetVerbRefusal(503, "the note store has not finished loading; retry")
        }
        when (name) {
            "SetSearchQuery" -> {
                navigator.searchQuery = required("query")
                receipt("query" to navigator.searchQuery)
            }

            "ClearSearchQuery" -> {
                navigator.searchQuery = ""
                receipt()
            }

            // A tap on the row: only a row of the list on screen, and the push its click makes.
            "OpenNote" -> {
                val id = required("noteId")
                rowOnThisScreen(noteRowTag(id))
                navigator.openNote(id)
                awaitEditorLoaded(bound, name) ?: receipt("noteId" to id)
            }

            else -> { // OpenFolder
                val path = required("path")
                rowOnThisScreen(folderRowTag(path))
                navigator.openFolder(path)
                receipt("path" to path)
            }
        }
    } catch (refusal: PuppetVerbRefusal) {
        PuppetContract.refusal(refusal.status, refusal.message)
    }
}

internal fun arguments(body: String): JSONObject =
    runCatching { JSONObject(body.ifEmpty { "{}" }) }.getOrDefault(JSONObject())

package com.futo.notes.puppet

import android.view.WindowManager
import androidx.compose.ui.semantics.SemanticsConfiguration
import androidx.compose.ui.unit.IntRect
import com.futo.notes.Prefs
import com.futo.notes.ui.navigation.Screen
import org.json.JSONArray
import org.json.JSONObject

/** The pure half: routing, schemas, and reply shaping, with no app state. */
internal object PuppetContract {
    /**
     * The listener's abstract local socket, a fixed name because an Android process gets no
     * launch environment the way `simctl` hands `FUTO_PUPPET_PORT` to iOS. The CLI forwards
     * the worktree's host port to it with `adb forward` (`ANDROID_LISTENER` in
     * crates/futo-puppet/src/target.rs).
     */
    const val SOCKET = "futo-puppet"
    const val MAX_REQUEST_BYTES = 256 * 1024
    const val TAG = "FutoPuppet"

    /**
     * Whether a connection's peer may drive the app: adbd, which `adb forward` connects through
     * as the shell user (root after `adb root`). Any app on the device can reach an abstract
     * socket, and each app runs as its own user, so every other peer is refused: it could read
     * and delete the user's notes.
     */
    fun mayConnect(uid: Int): Boolean = uid == SHELL_UID || uid == ROOT_UID

    // Process.ROOT_UID and SHELL_UID, which arrived in API 29, above minSdk.
    private const val ROOT_UID = 0
    private const val SHELL_UID = 2000

    /**
     * Whether a window over the activity's takes every touch, so nothing under it is on
     * screen: a dialog, or a focusable popup such as a menu. A window that cannot take focus
     * never does — Android turns FLAG_NOT_TOUCH_MODAL on for it — and a text caret's handle
     * is one of those.
     */
    fun touchModal(type: Int, flags: Int): Boolean =
        type != WindowManager.LayoutParams.TYPE_BASE_APPLICATION &&
            (flags and (WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE)) == 0

    /** The first-run storage picker, before there is a vault or a shell to drive. */
    const val ONBOARDING = "onboarding"

    /** Nothing composed at all: the activity is gone (system Back at the root) or not drawn yet. */
    const val NO_SCREEN = "none"

    /**
     * What the shell owns — a row's tap, Back, and the Search field the navigator holds — each
     * with the catalog keys of its controls' labels (PuppetVerb's `controls`): a row reads
     * `→ Verb`, and `just check-puppet-verbs` holds each labelled control to a verb. Every other
     * control is a verb its own screen registers (PuppetVerbScope).
     */
    val nativeControls: Map<String, List<String>> = linkedMapOf(
        "OpenNote" to emptyList(),
        "GoBack" to listOf("common.actions.back"),
        "OpenFolder" to emptyList(),
        "SetSearchQuery" to emptyList(),
        "ClearSearchQuery" to listOf("search.clearAccessibilityLabel"),
    )
    val queries = listOf(
        "elements", "state", "notes", "search", "observe", "clipboard", "doc", "at", "show",
        "events", "diff", "trace", "touches",
    )

    /**
     * Queries the WebView answers about the page it is showing. The WebView is one
     * long-lived instance, so it still holds the last note's document after a GoBack:
     * forwarded from a native screen, one of these answers about a screen the user is
     * not on. They are refused there instead. `clipboard` is not one — it is the
     * agent's own buffer, not the page's, and survives navigation.
     */
    val pageQueries = setOf("elements", "doc", "at", "show", "events", "diff", "trace")

    /**
     * Every setting the app stores (the whole `futo_prefs` file), under its own keys. Nothing
     * is picked, so a setting nobody thought to report still shows in a receipt. The sync
     * password's Keystore iv and ciphertext show only whether they are set.
     */
    fun storedSettings(all: Map<String, *>): JSONObject = JSONObject().apply {
        for ((key, value) in all) {
            put(
                key,
                when {
                    key in SECRET_SETTINGS -> if (value == null) JSONObject.NULL else "set"
                    value is Set<*> -> JSONArray(value.sortedBy { it.toString() })
                    else -> value ?: JSONObject.NULL
                },
            )
        }
    }

    private val SECRET_SETTINGS = setOf(Prefs.SYNC_PASSWORD_IV, Prefs.SYNC_PASSWORD_CT)

    /**
     * The vault itself, not the rows: every note id and every folder the store knows,
     * including folders no note is left in. The shape the desktop shell's `vault()`
     * and the iOS listener answer with, so one driver reads all three.
     */
    fun vault(noteIds: List<String>, folders: List<String>, modified: Map<String, Long>? = null): JSONObject =
        JSONObject()
            .put("notes", JSONArray(noteIds.sorted()))
            .put("folders", JSONArray(folders.sorted()))
            .apply {
                // What `futo-puppet` diffs a receipt's vault by, asked for with `notes {"modified":true}`.
                if (modified != null) put("modified", JSONObject(modified))
            }

    /**
     * `search {"query", "limit"?}`: the query as sent (a trailing space tells the engine the
     * last word is finished) and how many hits, 10 unless given; null for a blank query or a
     * limit that is not a positive whole number.
     */
    fun searchRequest(body: String): Pair<String, UInt>? {
        val arguments = runCatching { JSONObject(body.ifEmpty { "{}" }) }.getOrNull() ?: return null
        val query = arguments.opt("query") as? String ?: return null
        if (query.isBlank()) return null
        if (!arguments.has("limit")) return query to 10u
        val limit = arguments.opt("limit") as? Int ?: return null
        return if (limit > 0) query to limit.toUInt() else null
    }

    fun route(method: String, path: String): PuppetRoute? {
        val verb = method.uppercase()
        return when {
            verb == "GET" && path == "/actions" -> PuppetRoute.Actions
            verb == "GET" && path == "/tree" -> PuppetRoute.Tree
            verb == "POST" && path.startsWith("/do/") && path.length > 4 ->
                PuppetRoute.Verb(path.substring(4))
            verb == "POST" && path.removePrefix("/") in queries ->
                PuppetRoute.Query(path.removePrefix("/"))
            else -> null
        }
    }

    /**
     * `list` for the vault root, which IS the home screen here — the same name
     * iOS reports for its note list, so a scenario reads the same on both.
     */
    fun screen(screen: Screen, openNote: String? = null): String = when (screen) {
        is Screen.Folder -> if (screen.path.isEmpty()) "list" else "folder:${screen.path}"
        // The entry keeps the id it was pushed with; a rename in place moves the note.
        is Screen.Editor -> "editor:${openNote ?: screen.noteId}"
        Screen.Search -> "search"
        Screen.Settings -> "settings"
        Screen.StorageLocation -> "storage"
        Screen.Sync -> "sync"
        Screen.Feedback -> "feedback"
    }

    /** Every argument is a string unless it is in [integers] or [booleans]; [required] must be there. */
    fun schema(
        required: List<String>,
        optional: List<String> = emptyList(),
        integers: List<String> = emptyList(),
        booleans: List<String> = emptyList(),
    ): JSONObject {
        val properties = JSONObject()
        for (name in required + optional) {
            val type = if (name in integers) "integer" else if (name in booleans) "boolean" else "string"
            properties.put(name, JSONObject().put("type", type))
        }
        // A verb behind a confirmation takes `answer`: the CLI presses the dialog's own button next.
        if (properties.has("answer")) {
            properties.put("answer", JSONObject().put("type", "string").put("enum", JSONArray(listOf("confirm", "dismiss"))))
        }
        return JSONObject()
            .put("type", "object")
            .put("properties", properties)
            .put("required", JSONArray(required))
    }

    /**
     * The shell's verbs for this screen, JSON Schema each, no prose. Each native
     * screen offers what its own controls do; a verb the user has no control for
     * here is not on the list and is refused as such.
     */
    fun nativeActions(screen: Screen, canGoBack: Boolean): JSONArray = JSONArray().apply {
        for (name in nativeNames(screen, canGoBack)) put(JSONObject().put("name", name).put("schema", nativeSchema(name)))
    }

    /** The names [nativeActions] lists, in order. */
    fun nativeNames(screen: Screen, canGoBack: Boolean): List<String> {
        // A row's tap and the Search field; everything else is a verb its screen registers.
        val here: List<String> = when (screen) {
            is Screen.Folder -> listOf("OpenNote", "OpenFolder")
            Screen.Search -> listOf("OpenNote", "SetSearchQuery", "ClearSearchQuery")
            else -> emptyList()
        }
        return if (canGoBack) here + "GoBack" else here
    }

    private fun nativeSchema(name: String): JSONObject = when (name) {
        "OpenNote" -> schema(listOf("noteId"))
        "OpenFolder" -> schema(listOf("path"))
        "SetSearchQuery" -> schema(listOf("query"))
        else -> schema(emptyList())
    }

    /**
     * Why [name] is not here. From the editor, the list's verbs are one GoBack away, and a
     * bare "no such verb" sent a driver round the same refusal until it gave up.
     */
    fun offScreen(name: String, screen: Screen): String {
        val listNames = nativeNames(Screen.Folder(""), canGoBack = true)
        return if (screen is Screen.Editor && name in listNames) {
            "$name is on the note list, and the editor is its own screen: GoBack first"
        } else {
            "no such verb on this screen: $name"
        }
    }

    /** Verbs by what their controls' labels read (`resolve` is the app's own catalog lookup). */
    fun controlLabels(verbs: List<Pair<String, List<String>>>, resolve: (String) -> String): JSONObject {
        val byLabel = linkedMapOf<String, MutableList<String>>()
        for ((name, keys) in verbs) {
            for (key in keys) byLabel.getOrPut(resolve(key)) { mutableListOf() }.let { if (name !in it) it += name }
        }
        return JSONObject().apply { for ((label, names) in byLabel) put(label, JSONArray(names)) }
    }

    /**
     * One `/actions` entry for a screen's own verb: a convenience verb says it is one, and a
     * verb with shortcut arguments says which steps each stands for (`[[verb, {args}], …]`).
     * The listener's own verbs ([nativeActions]) declare no shortcuts.
     */
    fun actionEntry(verb: PuppetVerb): JSONObject = JSONObject()
        .put("name", verb.name)
        .put("schema", schema(verb.required, verb.optional, verb.integers, verb.booleans))
        .apply {
            if (verb.convenience) put("convenience", true)
            if (verb.shortcuts.isNotEmpty()) {
                val shortcuts = JSONObject()
                for ((argument, steps) in verb.shortcuts) {
                    shortcuts.put(argument, JSONArray(steps.map { (step, arguments) -> JSONArray().put(step).put(JSONObject(arguments)) }))
                }
                put("shortcuts", shortcuts)
            }
        }

    /**
     * One merged semantics node as the tree walk found it: its configuration, its on-screen
     * rect clipped to the screen, its root and every ancestor, the [window] (Compose root) it
     * is in, and [end], the walk index just past its last descendant — so the nodes from here
     * to [end] are inside it, and everything from [end] on is drawn over it.
     */
    class SeenNode(val config: SemanticsConfiguration, val rect: IntRect, val window: Int = 0) {
        var end = 0
    }

    /** What of this rect a [cover] drawn over it leaves; null when it covers all of it. */
    fun IntRect.uncoveredBy(cover: IntRect): IntRect? {
        if (!overlaps(cover)) return this
        val spansWidth = cover.left <= left && cover.right >= right
        val spansHeight = cover.top <= top && cover.bottom >= bottom
        return when {
            spansWidth && spansHeight -> null
            spansWidth && cover.top <= top -> IntRect(left, cover.bottom, right, bottom)
            spansWidth && cover.bottom >= bottom -> IntRect(left, top, right, cover.top)
            spansHeight && cover.left <= left -> IntRect(cover.right, top, right, bottom)
            spansHeight && cover.right >= right -> IntRect(left, top, cover.left, bottom)
            else -> this
        }
    }

    fun refusal(status: Int, error: String): PuppetReply =
        PuppetReply(status, JSONObject().put("ok", false).put("error", error).toString())

    /** The JS the host evaluates to forward one command. */
    fun forwardScript(command: String, argsJson: String): String =
        "window.__futoPuppet ? window.__futoPuppet.run(" +
            "${JSONObject.quote(command)}, ${JSONObject.quote(argsJson)}) : null"

    /** Split the WebView's `{"status":…,"body":…}` reply into an HTTP response. */
    fun response(forwarded: String?): PuppetReply {
        if (forwarded == null) {
            return refusal(503, "the editor webview has no puppet inspector yet; retry")
        }
        val broken = "the webview returned something other than {status, body}"
        val parsed = runCatching { JSONObject(forwarded) }.getOrNull() ?: return refusal(502, broken)
        val status = parsed.optInt("status", 0)
        if (status == 0) return refusal(502, broken)
        // Wrapping in an array and unwrapping the text renders any JSON type —
        // object, array, string, number — exactly as the page meant it.
        val wrapped = JSONArray().put(parsed.opt("body") ?: JSONObject.NULL).toString()
        return PuppetReply(status, wrapped.substring(1, wrapped.length - 1))
    }

    fun reasonPhrase(status: Int): String = when (status) {
        200 -> "OK"
        400 -> "Bad Request"
        403 -> "Forbidden"
        404 -> "Not Found"
        409 -> "Conflict"
        502 -> "Bad Gateway"
        503 -> "Service Unavailable"
        else -> "Internal Server Error"
    }
}

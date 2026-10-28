package com.futo.notes.puppet

import android.content.SharedPreferences
import android.net.LocalServerSocket
import android.net.LocalSocket
import android.os.Build
import android.util.Log
import android.view.View
import android.view.inspector.WindowInspector
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import com.futo.notes.NotesStore
import com.futo.notes.SyncManager
import com.futo.notes.ui.EditorHost
import com.futo.notes.ui.currentToast
import com.futo.notes.ui.navigation.AppNavigator
import com.futo.notes.ui.navigation.Screen
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * The debug-only listener `futo-puppet` (crates/futo-puppet) drives the Android
 * app through — the counterpart of `apps/ios/Sources/App/PuppetServer.swift`,
 * speaking the same wire so the CLI needs one extra target arm and nothing else.
 *
 * Two kinds of work arrive here. Navigation verbs and the screens' own verbs run
 * on the main thread against the same [AppNavigator] and handlers the UI calls.
 * Everything else — editor verbs and every inspect query — is forwarded verbatim
 * to the editor WebView's `window.__futoPuppet.run(command, argsJson)`
 * (src/app/puppet), which answers with the `{status, body}` relayed unchanged.
 *
 * Wire: `GET /actions` · `GET /tree` (`{screen, scale, nodes, scroll, controls, webview}`:
 * the native screens' merged Compose semantics as `{role, text, id, x, y, w, h, actions, flags,
 * section}` in device pixels, windows bottom to top, and per scrolling container `{section, up,
 * down, left, right, first?, last?, total?}` — the same shape iOS answers, so the CLI can see
 * and aim at a Compose row, say which part of the screen it is in, and how far its list goes;
 * `webview` is where the editor WebView sits, `{x, y, w, h}` or null, so the CLI can aim at a
 * CSS pixel; the WebView's content is left to the page) ·
 * `POST /do/<Verb>` (body = args) · `POST /<query>` (state, notes, search, observe, clipboard,
 * touches, and the page queries elements, doc, at, show, events, diff, trace — refused off
 * the editor screen). A Compose screen's own controls (the title field, the find bar, the ⋯
 * menu, a list's New note and row menus, a dialog or sheet) are the verbs it registers
 * through [PuppetVerbs] while it is on screen; a list screen also publishes its rows there
 * (PuppetListRows.kt), which is what OpenNote, OpenFolder and the row-menu verbs accept.
 *
 * Debug builds only. This file lives in the `debug` source set and a release
 * build compiles the no-op sibling at the same name instead, so the release APK
 * carries no shell-reachable way to move the user's notes.
 * Design record: docs/research/agent-native-app-design.md.
 */
internal object PuppetServer {
    internal class Binding(
        val navigator: AppNavigator,
        val store: NotesStore,
        val host: EditorHost,
        val sync: SyncManager,
        val prefs: SharedPreferences,
        /** The shell's own view: its display, its density, and on API 28 its window. */
        val shellView: View,
    )

    /** The composed shell's binding, or null before (or after) it. Main thread only. */
    private var binding: Binding? = null

    @Volatile
    private var socket: LocalServerSocket? = null

    /** Point the listener at the live shell, opening it on first call. */
    fun bind(bound: Binding) {
        PuppetTouches.install(bound.shellView)
        binding = bound
        open()
    }

    fun unbind(bound: Binding) {
        if (binding === bound) binding = null
    }

    @Synchronized
    fun open() {
        if (socket != null) return
        val opened = runCatching { LocalServerSocket(PuppetContract.SOCKET) }.getOrElse { error ->
            Log.e(PuppetContract.TAG, "could not bind @${PuppetContract.SOCKET}: $error")
            return
        }
        socket = opened
        // One accept loop, one request at a time: commands land in arrival order
        // without a lock, which is what the iOS listener buys with its serialised
        // main-actor task chain.
        thread(isDaemon = true, name = "futo-puppet") {
            while (true) {
                val connection = runCatching { opened.accept() }.getOrNull() ?: break
                runCatching { serve(connection) }
                    .onFailure { Log.e(PuppetContract.TAG, "request failed: $it") }
            }
        }
        Log.i(PuppetContract.TAG, "listening on @${PuppetContract.SOCKET}")
    }

    private fun serve(connection: LocalSocket) {
        // A client that stalls mid-request must not hold the one accept loop.
        connection.soTimeout = 10_000
        connection.use {
            val peer = it.peerCredentials.uid
            val reply = if (PuppetContract.mayConnect(peer)) {
                respond(PuppetHttpRequest.read(it.getInputStream()) ?: return)
            } else {
                Log.w(PuppetContract.TAG, "refused uid $peer: only adb may drive the app")
                PuppetContract.refusal(403, "only adb may drive the app; uid $peer is refused")
            }
            val body = reply.body.toByteArray(Charsets.UTF_8)
            val header = "HTTP/1.1 ${reply.status} ${PuppetContract.reasonPhrase(reply.status)}\r\n" +
                "Content-Type: application/json\r\n" +
                "Content-Length: ${body.size}\r\n" +
                "Connection: close\r\n\r\n"
            it.getOutputStream().apply {
                write(header.toByteArray(Charsets.UTF_8))
                write(body)
                flush()
            }
        }
    }

    private fun respond(request: PuppetHttpRequest): PuppetReply {
        val route = PuppetContract.route(request.method, request.path)
            ?: return PuppetContract.refusal(
                404, "no such route: ${request.method} ${request.path}",
            )
        return runBlocking(Dispatchers.Main) {
            val bound = binding
            if (bound == null) beforeShell(route, request.body) else perform(bound, route, request.body)
        }
    }

    /**
     * No shell yet: a first-run screen (the storage picker) is on top, with no note list,
     * no store and no editor. Only the verbs that screen registered are there to take.
     */
    private suspend fun beforeShell(route: PuppetRoute, body: String): PuppetReply {
        fun menu() = JSONArray().apply { for (verb in PuppetVerbs.all(null)) put(PuppetContract.actionEntry(verb)) }
        // The storage picker is the one screen composed before the shell; with nothing
        // composed, the app is not showing anything.
        val screen = if (PuppetVerbs.all(null).isEmpty()) PuppetContract.NO_SCREEN else PuppetContract.ONBOARDING
        val registered = (route as? PuppetRoute.Verb)?.let { PuppetVerbs.verb(it.name, null) }
        return when {
            route == PuppetRoute.Actions ->
                PuppetReply(200, JSONObject().put("screen", screen).put("actions", menu()).toString())
            route == PuppetRoute.Query("state") -> PuppetReply(
                200,
                JSONObject().put("screen", screen).put("foreground", screen != PuppetContract.NO_SCREEN)
                    .put("toast", currentToast).toString(),
            )
            route == PuppetRoute.Query("observe") -> PuppetReply(
                200,
                JSONObject().put("screen", screen).put("actions", menu())
                    .put("notes", JSONArray()).put("folders", JSONArray())
                    .put("lines", JSONArray()).put("elements", JSONArray()).toString(),
            )
            registered != null -> screenVerb(registered, body)
            screen == PuppetContract.NO_SCREEN -> PuppetContract.refusal(
                503,
                "the app is showing no screen: it was closed (system Back at the root) or has not drawn one yet",
            )
            // The picker is a screen like any other to read and aim at: every `do` reads it
            // before and after for its receipt, so a refusal here refused the picker's verbs.
            // `ponytail:` API 28 has no window list before the shell; it keeps the refusal.
            route == PuppetRoute.Tree && Build.VERSION.SDK_INT >= 29 -> {
                val all = WindowInspector.getGlobalWindowViews()
                val anchor = all.firstOrNull { it.isShown }
                    ?: return PuppetContract.refusal(503, "the app is showing no window yet")
                tree(anchor, all, null)
            }
            else -> PuppetContract.refusal(503, "the app shell is not on screen yet; the $screen screen's verbs are all there is")
        }
    }

    private suspend fun perform(
        bound: Binding,
        route: PuppetRoute,
        body: String,
    ): PuppetReply = when (route) {
        PuppetRoute.Actions -> actions(bound)
        PuppetRoute.Tree -> tree(bound)
        is PuppetRoute.Verb -> {
            val registered = PuppetVerbs.verb(route.name, bound.navigator.currentScreen)
            when {
                // A modal dialog covers the screen: only its own verbs reach anything.
                registered == null && PuppetVerbs.modalUp() -> PuppetContract.refusal(
                    404,
                    "a dialog is open; ${route.name} is behind it. On screen: " +
                        PuppetVerbs.all(bound.navigator.currentScreen).joinToString { it.name },
                )
                route.name in PuppetContract.nativeControls -> nativeVerb(bound, route.name, body)
                // A control on the Compose screen itself: registered while that screen
                // is on top, so being registered IS being on this screen.
                registered != null -> screenVerb(registered, body)
                else -> requireOpenEditor(bound.navigator.currentScreen, route.name)
                    ?: awaitEditorLoaded(bound, route.name)
                    ?: forward(
                        bound,
                        "do",
                        JSONObject()
                            .put("verb", route.name)
                            .put("args", arguments(body))
                            .toString(),
                    )
            }
        }
        is PuppetRoute.Query -> when {
            route.command == "state" -> PuppetReply(200, stateObject(bound).toString())
            route.command == "notes" ->
                PuppetReply(200, vault(bound, modified = arguments(body).optBoolean("modified")).toString())
            route.command == "touches" -> {
                PuppetTouches.install(bound.shellView)
                val cursor = arguments(body).let { if (it.has("since")) it.getInt("since") else null }
                val covered = touchModalAbove(windows(bound), bound.shellView.rootView) >= 0
                PuppetReply(200, PuppetTouches.since(cursor, covered).toString())
            }
            route.command == "search" -> search(bound, body)
            route.command == "file" -> file(bound, body)
            route.command == "observe" -> observe(bound)
            route.command in PuppetContract.pageQueries && bound.navigator.currentScreen !is Screen.Editor ->
                PuppetContract.refusal(
                    503,
                    "${route.command} reads the editor webview; this screen is native. " +
                        "Use `notes` for the vault and `state` for the screen",
                )
            else -> forward(bound, route.command, body.ifEmpty { "{}" })
        }
    }
}

/**
 * Open the listener for as long as this shell is composed. Mirrors iOS's
 * `PuppetServerStart` view modifier.
 */
@Composable
internal fun PuppetServerStart(
    navigator: AppNavigator,
    store: NotesStore,
    sync: SyncManager,
    prefs: SharedPreferences,
) {
    val context = LocalContext.current
    val view = LocalView.current
    DisposableEffect(navigator, store) {
        val bound = PuppetServer.Binding(navigator, store, EditorHost.get(context), sync, prefs, view)
        PuppetServer.bind(bound)
        onDispose { PuppetServer.unbind(bound) }
    }
}

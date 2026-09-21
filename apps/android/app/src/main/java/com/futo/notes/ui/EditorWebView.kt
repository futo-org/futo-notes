package com.futo.notes.ui

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.HapticFeedbackConstants
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import java.util.UUID
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import com.futo.notes.BuildConfig
import com.futo.notes.localization.Localization
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONArray
import org.json.JSONObject
import kotlin.coroutines.resume

/**
 * Whether a top-level navigation may load inside the reused editor WebView.
 * Only local `file://` editor assets qualify; external links are handed to the
 * system browser so they never replace editor.html.
 */
internal fun isInAppEditorNavigation(scheme: String?): Boolean =
    scheme.equals("file", ignoreCase = true)

internal data class FindMatchesReport(
    val query: String,
    val current: Int,
    val total: Int,
    val label: String,
)

internal fun decodeFindMatches(msg: JSONObject): FindMatchesReport? {
    if (!msg.has("query") || !msg.has("current") || !msg.has("total") || !msg.has("label")) {
        return null
    }
    return FindMatchesReport(
        query = msg.optString("query"),
        current = msg.optInt("current"),
        total = msg.optInt("total"),
        label = msg.optString("label"),
    )
}

/**
 * Rejects an engine echo for an older native query. Android's EditText may
 * still have an active composing span when a bridge message arrives; applying
 * an older query there would replace the user's in-progress IME text.
 */
internal class FindReportGate {
    private var isOpen = false
    private var expectedQuery: String? = null

    fun opened() {
        isOpen = true
        expectedQuery = null
    }

    fun queryChanged(query: String) {
        isOpen = true
        expectedQuery = query
    }

    fun closed() {
        isOpen = false
        expectedQuery = null
    }

    fun accepts(report: FindMatchesReport): Boolean {
        if (!isOpen) return false
        val expected = expectedQuery
        if (expected != null && report.query != expected) return false
        expectedQuery = report.query
        return true
    }
}

internal fun isCurrentFindReportOwner(
    postedAttachmentGeneration: Long,
    currentAttachment: EditorAttachmentToken?,
): Boolean = currentAttachment?.generation == postedAttachmentGeneration

/**
 * Compose host for the embedded markdown editor — the Android counterpart of
 * the iOS `EditorWebView.swift`. Loads the SAME `editor.html` bundle (staged
 * into assets) and speaks the identical `futoBridge` contract:
 *
 *   - editor → host: messages posted to `window.futoBridge.postMessage(json)`
 *     (the injected `@JavascriptInterface`) — `ready` / `change` / `focus` /
 *     `openNote` / `pickImage` (bridge v2) / `cursorContext` (bridge v3) /
 *     `openUrl` (bridge v6) / `initialized` + `bridgeVersionMismatch`
 *     (bridge v7) / `formatState` (unversioned, Milkdown engine only — see
 *     bridge.ts's BRIDGE_VERSION doc comment).
 *   - host → editor: `window.FutoEditor.initialize` (bridge v7 — the whole boot
 *     config in one call) plus `setContent/getContent/focus/setTheme/setNotes/
 *     applyExternalContent/insertImage/setImageBaseUrl` and the bridge-v3
 *     native-toolbar calls `exec/blur/setNativeToolbar`, via
 *     `evaluateJavascript`.
 *
 * The WebView is NOT created per note-open. A cold WebView boot (Chromium
 * renderer start + parse/exec of the ~2 MB editor bundle + CodeMirror mount)
 * costs ~0.2–0.5 s, which used to land on the navigation critical path: the
 * native Compose chrome painted instantly while the editor lagged behind.
 *
 * Instead a single [EditorHost] owns ONE WebView, pre-warmed once at app start
 * (see `MainActivity` / [EditorHost.prewarm]). Opening a note reparents that
 * already-`ready` WebView into the current composition and pushes content with
 * a single `setContent` call — no boot on the open path. Animated navigation can
 * briefly compose an outgoing and incoming editor together; the attachment
 * token makes only the newest binding eligible to mutate the shared WebView.
 */
@Composable
internal fun EditorWebView(
    content: String,
    theme: String,
    languageTag: String,
    autoFocus: Boolean,
    onChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    notesJson: String? = null,
    imageBaseUrl: String? = null,
    /** Reports this composition's token so passive work can reject a stale owner. */
    onAttachmentChange: (EditorAttachmentToken?) -> Unit = {},
    onOpenNote: (String) -> Unit = {},
    onPickImage: (String) -> Unit = {},
    onSaveImageData: (String, String) -> Unit = { _, _ -> },
    onPasteClipboardImage: () -> Unit = {},
    onFindMatches: (FindMatchesReport) -> Unit = {},
    onReady: () -> Unit = {},
) {
    val context = LocalContext.current
    val host = remember { EditorHost.get(context) }
    var attachment by remember { mutableStateOf<EditorAttachmentToken?>(null) }

    // Only the composition that owns the current attachment may push into the
    // app-lifetime WebView. AnimatedContent briefly recomposes both screens;
    // without this gate, the outgoing screen's ordinary state push could undo
    // the incoming screen's content even when reconciliation itself was fenced.
    if (attachment?.let(host::isCurrentAttachment) == true) {
        host.setTheme(theme)
        host.setLanguage(languageTag)
        host.setContent(content)
        if (notesJson != null) host.setNotes(notesJson)
        if (imageBaseUrl != null) host.setImageBaseUrl(imageBaseUrl)
    }

    // Bind this note's callbacks for the lifetime of this composition. The
    // generation token guards against a future nav change attaching a new
    // note before this one's onDispose runs (it would otherwise clobber the
    // newer binding).
    DisposableEffect(Unit) {
        val token = host.attach(
            autoFocus,
            onChange,
            onReady,
            onOpenNote,
            onPickImage,
            onSaveImageData,
            onPasteClipboardImage,
            onFindMatches,
        )
        attachment = token
        host.setTheme(theme)
        host.setLanguage(languageTag)
        host.setContent(content)
        if (notesJson != null) host.setNotes(notesJson)
        if (imageBaseUrl != null) host.setImageBaseUrl(imageBaseUrl)
        onAttachmentChange(token)
        onDispose {
            host.detach(token)
            attachment = null
            onAttachmentChange(null)
        }
    }

    // Re-adopt the WebView whenever the host rebuilds it (renderer-process
    // recovery, below). Reading `recreations` subscribes this composable; the
    // key() tears down the stale AndroidView and re-runs factory with the new
    // WebView instance.
    val recreations = host.recreations
    key(recreations) {
        AndroidView(
            modifier = modifier,
            // The host owns the WebView for the whole app lifetime; detach it
            // from its previous Compose holder before this composition adopts it.
            factory = {
                (host.webView.parent as? ViewGroup)?.removeView(host.webView)
                host.webView
            },
        )
    }
}

internal fun decodeJavascriptString(result: String?): String? {
    if (result == null) return null
    return runCatching {
        val wrapped = JSONArray("[$result]")
        if (wrapped.isNull(0)) null else wrapped.getString(0)
    }.getOrNull()
}

/**
 * Owns the single, app-lifetime editor WebView. Pre-warmed once so it has
 * already reached `ready` (bundle parsed, CodeMirror mounted) by the time the
 * user opens a note. Per-note bindings ([onChange]/[onReady]/[autoFocus]) are
 * swapped on each [attach]; the bridge forwards to whatever is currently bound.
 *
 * Construction must happen on the main thread (WebView requirement). Held via
 * the application context so it outlives Activity instances (rotation) without
 * leaking them.
 */
class EditorHost private constructor(appContext: Context) {
    private var onChange: (String) -> Unit = {}
    private var onReady: () -> Unit = {}
    private var onOpenNote: (String) -> Unit = {}
    private var onPickImage: (String) -> Unit = {}
    private var onSaveImageData: (String, String) -> Unit = { _, _ -> }
    private var onPasteClipboardImage: () -> Unit = {}
    private var onFindMatches: (FindMatchesReport) -> Unit = {}
    private var autoFocus = false

    // Reactive inputs for the NATIVE Compose toolbar (EditorToolbar.kt), fed by
    // bridge messages — the Android counterpart of iOS's EditorToolbarState.
    /** Editor has focus (soft keyboard up) — the toolbar shows only then. */
    var editorFocused by mutableStateOf(false)
        private set
    /**
     * Cursor is on a list line specifically. [inContainer] is what actually
     * gates the Indent/Outdent items now; this stays only as the fallback for
     * a bundle old enough to have never sent `inContainer` at all.
     */
    var onListLine by mutableStateOf(false)
        private set
    /**
     * Cursor is in a list item OR a blockquote (bridge `cursorContext.
     * inContainer`) — shows the Indent/Outdent items. `null` means the
     * message hasn't carried this field at all (an older bundle); the
     * toolbar then falls back to [onListLine], exactly today's behavior for
     * that bundle.
     */
    var inContainer by mutableStateOf<Boolean?>(null)
        private set
    /**
     * Toolbar-manifest ids active at the cursor/selection (bridge
     * `formatState`) — drives the Notion-style highlighted button state in
     * EditorToolbar.kt, the counterpart of iOS's EditorToolbarState. Empty on
     * editors that never send `formatState` (the CodeMirror engine), so no
     * button lights up there.
     */
    var activeFormats by mutableStateOf<Set<String>>(emptySet())
        private set

    /**
     * Toolbar-manifest ids that are currently INERT (bridge
     * `formatState.disabled`) — today only `undo`/`redo` with an empty
     * prosemirror-history stack. Same message, same dedupe as
     * [activeFormats]; the counterpart is iOS's
     * `EditorToolbarState.disabledFormats` (EditorToolbar.swift).
     */
    var disabledFormats by mutableStateOf<Set<String>>(emptySet())
        private set

    /** The bundle has applied this shell's host config and the note is on
     *  screen (the `initialized` message) — not merely that the page loaded. */
    private var isReady = false

    // What this shell last SENT the bundle, so a recomposition per keystroke
    // (the composable pushes on every one) does not become an
    // evaluateJavascript per keystroke carrying the whole note universe (M5).
    // Purely a transport gate — what counts as a change, and what the editor
    // does about it, is decided in packages/editor/src/hostBoot.ts. iOS keeps
    // the same gate for the same reason; the right way to retire both is to
    // stop pushing from a composition body, not to delete the compares.
    private var currentTheme: String? = null
    private var currentLanguageTag: String? = null
    private var lastPushedContent: String? = null
    private var desiredTheme: String = "light"
    private var desiredLanguageTag: String = "en"
    private var desiredContent: String = ""
    // Note universe + image base (bridge v2). The notes JSON can be large, so
    // dedupe holds only its hash, not the string.
    private var desiredNotesJson: String? = null
    private var lastNotesJsonHash: Int? = null
    private var desiredImageBaseUrl: String? = null
    private var currentImageBaseUrl: String? = null

    private val attachments = EditorAttachmentGate()
    private val findReportGate = FindReportGate()
    @Volatile
    private var bridgeAttachmentGeneration = -1L

    private val main = Handler(Looper.getMainLooper())

    private val bridge = object {
        @JavascriptInterface
        fun postMessage(json: String) {
            val msg = runCatching { JSONObject(json) }.getOrNull() ?: return
            val postedAttachmentGeneration = bridgeAttachmentGeneration
            main.post { handle(msg, postedAttachmentGeneration) }
        }
    }

    private val appContext = appContext
    private var localization: Localization? = null

    /** Stable across rotation, fresh after process death. */
    val processToken: String = UUID.randomUUID().toString()

    /** Bumped each time [webView] is rebuilt after a renderer-process death, so
     *  the [EditorWebView] composable re-adopts the fresh instance (key()). */
    var recreations by mutableStateOf(0)
        private set

    /**
     * Why this WebView's engine can't run the editor bundle, or null while
     * nothing says it can't — the boot OUTCOME, not a version number
     * (EditorEngineSupport.kt). Because the host is pre-warmed at app start
     * ([prewarm]), it is already decided by the first note-open; the editor
     * screen reads it to swap in [LegacyWebViewNotice] instead of a blank pane.
     */
    var engineFailure by mutableStateOf<String?>(null)
        private set

    /**
     * The editor engine has come up (`window.__futoEditorMounted`) — the only
     * thing this gate decides, so once it is true there is nothing left to probe.
     * Deliberately NOT `window.FutoEditor`, which the module's top level
     * publishes before Milkdown's async editor creation has run or failed.
     *
     * Deliberately NOT [isReady], which on bridge v7 means the whole
     * `initialize(config)` round-trip came back (the `initialized` message) — a
     * strictly later point. Gating on that would leave the notice one config
     * round-trip away from an engine that demonstrably runs the editor, and would
     * make an unrelated handshake bug look like an unsupported WebView.
     */
    private var engineBooted = false

    /** The post-grace-period probe (see [ENGINE_BOOT_GRACE_MS]). Held as one
     *  Runnable so a boot or a rebuild can cancel it — left queued, it would
     *  keep a destroyed WebView alive for the rest of the grace period. */
    private val graceProbe = Runnable { probeEngine(isFinal = true) }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(): WebView = WebView(appContext).apply {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        // Required twice over: editor.html itself is a file:// asset, and local
        // note images render from file://<notesRoot>/ (setImageBaseUrl). Do not
        // remove [editor.md:121].
        settings.allowFileAccess = true
        setBackgroundColor(android.graphics.Color.TRANSPARENT)
        // Debug builds only. This flag is what makes a NON-debuggable app
        // inspectable (the default is false; a debuggable app is inspectable
        // regardless), so shipping it `true` handed any authorized adb host a
        // chrome://inspect session into the editor — and through the single
        // postMessage bridge below, the whole vault: the note universe arrives
        // via setNotes, `openNote` + getContent() reads any note, `change`
        // rewrites it. iOS gates the same capability with #if DEBUG
        // (apps/ios/Sources/Editor/EditorWebView.swift). `just cdp-forward`
        // drives com.futo.notes.dev, so the dev tooling is unaffected.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        addJavascriptInterface(bridge, "futoBridge")
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?,
            ): Boolean {
                val url = request?.url ?: return false
                if (isInAppEditorNavigation(url.scheme)) return false
                try {
                    appContext.startActivity(
                        Intent(Intent.ACTION_VIEW, url)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                } catch (e: Exception) {
                    Log.w("FutoEditor", "No app to open external URL $url", e)
                }
                return true
            }

            // The renderer process died (OOM, or the system reclaimed it while
            // backgrounded). With no override the default returns false, which
            // takes the WHOLE app process down with it — and the editor is the
            // core surface. Return true to keep the app alive, then rebuild the
            // (now-unusable) WebView. desiredContent/theme/notes are retained on
            // the host, so the reloaded editor restores the open note.
            override fun onRenderProcessGone(
                view: WebView?,
                detail: RenderProcessGoneDetail?,
            ): Boolean {
                Log.e(
                    "FutoEditor",
                    "WebView renderer gone (didCrash=${detail?.didCrash()}); rebuilding",
                )
                main.post { rebuildWebView() }
                return true
            }

            // Ask the loaded page for the engine's capability verdict now
            // (EditorEngineSupport.kt), and once more after the boot grace
            // period in case the bundle is still mounting.
            override fun onPageFinished(view: WebView?, url: String?) {
                // A page that died mid-gesture never posted its `blockPress`
                // false — see setBlockPressActive.
                view?.isHapticFeedbackEnabled = true
                probeEngine(isFinal = false)
                main.removeCallbacks(graceProbe)
                main.postDelayed(graceProbe, ENGINE_BOOT_GRACE_MS)
            }
        }
        loadUrl("file:///android_asset/editor.html")
    }

    /** Ask the page whether the editor bundle mounted, and record any failure.
     *  Nothing to ask once the answer is in either direction — a recorded failure
     *  is only ever cleared by a later boot or a rebuild. */
    private fun probeEngine(isFinal: Boolean) {
        if (engineBooted || engineFailure != null) return
        val probed = webView
        probed.evaluateJavascript(ENGINE_PROBE_JS) { raw ->
            // A rebuild (renderer recovery) took over while the probe was in
            // flight: that WebView's verdict is no longer this host's.
            if (probed !== webView) return@evaluateJavascript
            val probe = decodeJavascriptString(raw)
            if (editorEngineBooted(probe)) {
                markEngineBooted()
                return@evaluateJavascript
            }
            val failure = editorEngineFailure(probe, isFinal) ?: return@evaluateJavascript
            engineFailure = failure
            Log.e("FutoEditor", "Editor engine can't run the bundle: $failure")
        }
    }

    /**
     * A message arrived, so something in the page is running. If the grace
     * period has already latched a failure, ask the gate once more.
     *
     * Without this a working engine that mounted LATER than
     * [ENGINE_BOOT_GRACE_MS] would sit behind the notice for the rest of the
     * session, because [probeEngine] stops asking once a failure is recorded
     * and nothing else re-opens the question. Reopening the note re-focuses the
     * editor, which posts, which lands here — the recovery the notice's own
     * "then reopen the note" promises.
     *
     * It can only ever CLEAR a failure: the probe stays the authority, so a
     * message from something other than a mounted editor changes nothing.
     */
    private fun rescueEngineVerdict() {
        if (engineBooted || engineFailure == null) return
        val probed = webView
        probed.evaluateJavascript(ENGINE_PROBE_JS) { raw ->
            if (probed !== webView) return@evaluateJavascript
            if (editorEngineBooted(decodeJavascriptString(raw))) markEngineBooted()
        }
    }

    /** This engine runs the editor, whatever its provider calls itself: stop
     *  probing, and disprove any failure a slow boot had already earned. */
    private fun markEngineBooted() {
        engineBooted = true
        main.removeCallbacks(graceProbe)
        engineFailure = null
    }

    var webView: WebView = createWebView()
        private set

    /** Replace the dead WebView with a fresh one and re-arm the editor state.
     *  Must run on the main thread. The renderer is gone, so the old instance
     *  is destroyed; the new one reloads editor.html and gets the same host
     *  config on its 'ready', which restores the open note.
     *
     *  Nothing but readiness and the engine verdict needs resetting — the config
     *  is applied unconditionally, so the dedupe markers [sendHostConfig] sets
     *  are correct for the fresh page too. */
    private fun rebuildWebView() {
        val dead = webView
        (dead.parent as? ViewGroup)?.removeView(dead)
        dead.destroy()
        isReady = false
        // The engine verdict is re-earned by the new WebView's own boot, and the
        // dead one's pending probe must not outlive it.
        main.removeCallbacks(graceProbe)
        engineBooted = false
        engineFailure = null
        webView = createWebView()
        recreations++
    }

    private fun handle(msg: JSONObject, postedAttachmentGeneration: Long) {
        rescueEngineVerdict()
        when (msg.optString("type")) {
            // The page is alive but shows nothing until it is configured. Hand
            // it this shell's whole intent in one call; the bundle owns the
            // order it applies them in and the bridge-version policy
            // (packages/editor/src/hostBoot.ts).
            "ready" -> sendHostConfig()
            // The config landed and the note is on screen — the point where
            // this shell's per-note follow-up is meaningful.
            "initialized" -> {
                isReady = true
                // NOT a shortcut to [markEngineBooted]. It used to be one, on
                // the reasoning that only the bundle can send this — true, and
                // beside the point: `initialize(config)` is answered by the host
                // API, which exists whether or not the EDITOR came up behind it.
                // Measured on futo-api30 (Chromium 83): Milkdown's async
                // `create()` threw, `initialized` still arrived, the engine was
                // marked booted, and the note showed a blank pane with no
                // update-WebView notice. The probe is the only gate; the rescue
                // it lost is [rescueEngineVerdict], above.
                // The desired state can have moved (a sync adopt, a theme flip)
                // between sending the config and this reply; each of these is
                // deduped and so a no-op when it hasn't.
                setTheme(desiredTheme)
                setLanguage(desiredLanguageTag)
                setContent(desiredContent)
                desiredImageBaseUrl?.let { setImageBaseUrl(it) }
                desiredNotesJson?.let { setNotes(it) }
                onReady()
                if (autoFocus) focusEditor()
            }
            // A stale editor.html next to a newer binary, or the reverse — a
            // build-hygiene problem, never a shipped one (the APK carries both).
            // The bundle boots anyway; this is the developer's alarm.
            "bridgeVersionMismatch" -> {
                val hostVersion = msg.optInt("hostVersion", -1)
                val bundleVersion = msg.optInt("bundleVersion", -1)
                Log.e(
                    "FutoBridgeDBG",
                    "Bridge version mismatch: editor.html reports v$bundleVersion, " +
                        "native expects v$hostVersion — rebuild the editor bundle",
                )
                if (BuildConfig.DEBUG) {
                    localization?.let {
                        Toast.makeText(
                            appContext,
                            it.localizedText(
                                "editor.android.bridgeVersionMismatch",
                                mapOf(
                                    "editorVersion" to bundleVersion.toString(),
                                    "nativeVersion" to hostVersion.toString(),
                                ),
                            ),
                            Toast.LENGTH_LONG,
                        ).show()
                    }
                }
            }
            "change" -> {
                val c = msg.optString("content")
                lastPushedContent = c
                onChange(c)
            }
            // Keyboard show/hide is handled natively by adjustResize; focus
            // gates the native toolbar's visibility (bridge v3).
            "focus" -> editorFocused = msg.optBoolean("focused")
            // Cursor moved on/off a list line (and, additively, a blockquote)
            // — drives Indent/Outdent visibility in the native toolbar
            // (deduped editor-side). `inContainer` may be absent from an
            // older bundle, which `has()` distinguishes from an explicit
            // `false` — `optBoolean` alone can't tell those apart.
            "cursorContext" -> {
                onListLine = msg.optBoolean("onListLine")
                inContainer = if (msg.has("inContainer")) msg.optBoolean("inContainer") else null
            }
            // Which toolbar-manifest commands cover the caret (deduped
            // editor-side) — the native toolbar tints those buttons. Milkdown
            // only; the CodeMirror engine never sends it.
            "formatState" -> {
                val ids = msg.optJSONArray("active")
                activeFormats = buildSet {
                    for (i in 0 until (ids?.length() ?: 0)) {
                        ids?.optString(i)?.takeIf { it.isNotEmpty() }?.let { add(it) }
                    }
                }
                // QA-003: Undo/Redo greyed out with an empty prosemirror-history
                // stack. Same message, additive field (bridge.ts).
                val disabledIds = msg.optJSONArray("disabled")
                disabledFormats = buildSet {
                    for (i in 0 until (disabledIds?.length() ?: 0)) {
                        disabledIds?.optString(i)?.takeIf { it.isNotEmpty() }?.let { add(it) }
                    }
                }
            }
            "findMatches" -> decodeFindMatches(msg)?.let { report ->
                if (
                    isCurrentFindReportOwner(
                        postedAttachmentGeneration,
                        attachments.current(),
                    ) && findReportGate.accepts(report)
                ) {
                    onFindMatches(report)
                }
            }
            // User tapped a RESOLVED wikilink — id is the target note's id
            // (vault-relative path sans .md) [editor.md:77].
            "openNote" -> onOpenNote(msg.optString("id"))
            // User tapped an EXTERNAL link — open it in the system browser. The
            // embed posts the URL instead of navigating, so shouldOverrideUrlLoading
            // never sees it; open it here through the SAME ACTION_VIEW path.
            "openUrl" -> {
                val url = msg.optString("url")
                if (url.isNotEmpty()) openExternalUrl(url)
            }
            // User tapped a toolbar image button; the host runs the native
            // picker and calls back via insertImage [editor.md:121].
            "pickImage" -> onPickImage(msg.optString("source"))
            // User pasted an image; the embed read the bytes (base64). Decode +
            // save into the vault off the main thread, then insertImage back.
            "saveImageData" -> {
                val data = msg.optString("data")
                val ext = msg.optString("ext")
                if (data.isNotEmpty() && ext.isNotEmpty()) onSaveImageData(data, ext)
            }
            // The embed classified the paste as an image it cannot read bytes
            // for itself (QA #006): Android's Chromium WebView exposes a
            // clipboard image copied from Photos/Files/Gallery/Drive as a
            // content:// URI riding on text/plain, not as a File, so
            // saveImageData never fires. Read the OS clipboard natively
            // instead — the same `pasteClipboardImage` round trip iOS's
            // hidden-pasteboard paste already uses.
            "pasteClipboardImage" -> onPasteClipboardImage()
            // Block-drag haptics. Both native shells mount the SAME
            // long-press block drag (blockDragMode.ts), so the three moments
            // and their feel are shared (bridge.ts HapticMessage).
            "haptic" -> performBlockDragHaptic(msg.optString("kind"))
            "blockPress" -> setBlockPressActive(msg.optBoolean("pressed"))
        }
    }

    /**
     * The Android half of the block-drag haptics iOS does with
     * `UIImpactFeedbackGenerator` / `UISelectionFeedbackGenerator`, mapped to
     * the closest platform constants so the two feel alike:
     *
     * - `lift`  — iOS medium impact; here [HapticFeedbackConstants.LONG_PRESS],
     *   the platform's own "you have picked this up".
     * - `move`  — iOS `selectionChanged()`; here
     *   [HapticFeedbackConstants.CLOCK_TICK], Android's picker/scrubber tick,
     *   which is the same "the bar is somewhere new" signal.
     * - `drop`  — iOS light impact; here
     *   [HapticFeedbackConstants.CONTEXT_CLICK], a lighter click than the lift.
     *
     * All three exist well below `minSdk` 28, so there is no API branching.
     * [android.view.View.performHapticFeedback] — NOT [android.os.Vibrator] —
     * because it needs no `VIBRATE` permission and honors the user's system
     * touch-feedback setting, the same way iOS's feedback generators honor
     * theirs. An unknown kind is dropped, matching iOS's `default: break`: a
     * future kind must not buzz the wrong way on an old host.
     *
     * [HapticFeedbackConstants.FLAG_IGNORE_VIEW_SETTING] because
     * [setBlockPressActive] turns the WebView's own view-level haptics OFF for
     * the duration of a block press — see there. The flag skips the VIEW's
     * setting only; the user's SYSTEM touch-feedback setting is still honored,
     * because `FLAG_IGNORE_GLOBAL_SETTING` is deliberately not passed.
     */
    private fun performBlockDragHaptic(kind: String) {
        val constant = when (kind) {
            "lift" -> HapticFeedbackConstants.LONG_PRESS
            "move" -> HapticFeedbackConstants.CLOCK_TICK
            "drop" -> HapticFeedbackConstants.CONTEXT_CLICK
            else -> null
        }
        // Emulators and haptics-less hardware feel nothing; this log is the
        // proof of receipt there, matching the iOS shell's.
        Log.d("FutoBridgeDBG", "haptic received: $kind")
        if (constant != null) {
            webView.performHapticFeedback(
                constant,
                HapticFeedbackConstants.FLAG_IGNORE_VIEW_SETTING,
            )
        }
    }

    /**
     * The Android half of the press-level suspension iOS does by standing
     * WKWebView's delayed text-interaction recognisers down (bridge.ts
     * `BlockPressMessage`) — and it is a MUCH smaller job here, because
     * Chromium is not WebKit.
     *
     * Measured on a moto g play 2023 (Android 13, System WebView 151), a
     * stationary hold on a block, focused and unfocused, five runs: no word
     * highlight, no selection handles, no floating Cut/Copy action mode, no
     * magnifier — the page's own defences in `mobileBlockDnd.ts` (cancelled
     * `selectstart`/`contextmenu`, re-collapsed selection, `preventDefault()`
     * on the drag's touch stream) are enough for Chromium, which — unlike
     * WebKit — lets the page have them. So none of iOS's
     * `isTextInteractionEnabled`/gesture-disabling machinery is needed here,
     * and `blockDrag` needs no host at all.
     *
     * ONE thing does leak through, and it is the whole reason this exists: the
     * WebView fires its OWN [HapticFeedbackConstants.LONG_PRESS] buzz when its
     * long-press gesture recogniser trips, 128-141 ms after the editor's `lift`
     * (measured across five holds; the recogniser fires around touch-down +
     * 480 ms against the editor's 340 ms lift). Two impacts a seventh of a
     * second apart read as a stutter, not as one pickup. The view-level flag is
     * the narrowest lever that silences it: it kills the WebView's own
     * feedback, [performBlockDragHaptic] opts past it, and a long press
     * anywhere the editor does NOT claim as a block press keeps its normal
     * buzz.
     *
     * Restored in `onPageFinished` as well as here, because a page that dies
     * mid-gesture never posts the matching `pressed: false` and the WebView
     * would stay mute for the rest of the session (the iOS shell resets in
     * `loadEditor()` for the same reason).
     */
    private fun setBlockPressActive(pressed: Boolean) {
        webView.isHapticFeedbackEnabled = !pressed
    }

    /**
     * Everything this shell wants the freshly-loaded page to be, sent once per
     * page load in reply to `ready`. The bundle applies it in its own order and
     * answers with `initialized` (packages/editor/src/hostBoot.ts), so a
     * renderer rebuild restores the open note by re-sending this and nothing
     * else.
     *
     * Auto-focus is deliberately NOT in here: raising the soft keyboard needs
     * the native focus + `showSoftInput` retry only this shell can do
     * (see [focusEditor]).
     */
    private fun sendHostConfig() {
        val config = JSONObject().apply {
            put("bridgeVersion", BridgeSpec.BRIDGE_VERSION)
            put("theme", desiredTheme)
            put("languageTag", desiredLanguageTag)
            put("content", desiredContent)
            // The markdown toolbar is native Compose here (EditorToolbar.kt),
            // so the embed must keep its own web toolbar hidden [editor.md].
            put("nativeToolbar", true)
            // Aligns the note body's left edge with the inline title field
            // (NoteEditorScreen's title BasicTextField, 22dp); the embed's
            // `.cm-line` contributes the remaining 6px. [list.md]
            put("contentPaddingInlinePx", CONTENT_PADDING_INLINE_PX)
            desiredNotesJson?.let { put("notesJson", it) }
            desiredImageBaseUrl?.let { put("imageBaseUrl", it) }
        }
        // Record what the config carries, so the catch-up on `initialized`
        // re-pushes only what actually moved while it was in flight.
        currentTheme = desiredTheme
        currentLanguageTag = desiredLanguageTag
        lastPushedContent = desiredContent
        lastNotesJsonHash = desiredNotesJson?.hashCode()
        currentImageBaseUrl = desiredImageBaseUrl

        eval(
            "window.FutoEditor && window.FutoEditor.initialize(" +
                "${JSONObject.quote(config.toString())});",
        )
    }

    /** Bind a note's callbacks. Returns a token for the matching [detach].
     *  If the editor is already warm, fires [onReady] (and focuses) now so the
     *  "ready for this note" contract holds for reused opens too. */
    internal fun attach(
        autoFocus: Boolean,
        onChange: (String) -> Unit,
        onReady: () -> Unit,
        onOpenNote: (String) -> Unit = {},
        onPickImage: (String) -> Unit = {},
        onSaveImageData: (String, String) -> Unit = { _, _ -> },
        onPasteClipboardImage: () -> Unit = {},
        onFindMatches: (FindMatchesReport) -> Unit = {},
    ): EditorAttachmentToken {
        this.onChange = onChange
        this.onReady = onReady
        this.onOpenNote = onOpenNote
        this.onPickImage = onPickImage
        this.onSaveImageData = onSaveImageData
        this.onPasteClipboardImage = onPasteClipboardImage
        this.onFindMatches = onFindMatches
        this.autoFocus = autoFocus
        val token = attachments.attach()
        bridgeAttachmentGeneration = token.generation
        if (isReady) {
            onReady()
            if (autoFocus) focusEditor()
        }
        return token
    }

    /** Unbind, unless a newer [attach] has already taken over. */
    internal fun detach(token: EditorAttachmentToken) {
        if (!attachments.permits(token)) return
        attachments.detach(token)
        bridgeAttachmentGeneration = -1L
        onChange = {}
        onReady = {}
        onOpenNote = {}
        onPickImage = {}
        onSaveImageData = { _, _ -> }
        onPasteClipboardImage = {}
        onFindMatches = {}
        autoFocus = false
        // Leaving the editor screen detaches the WebView without a blur event;
        // clear the flag so a reopened note doesn't flash a stale toolbar.
        editorFocused = false
    }

    internal fun currentAttachment(): EditorAttachmentToken? = attachments.current()

    internal fun isCurrentAttachment(token: EditorAttachmentToken): Boolean =
        attachments.permits(token)

    fun setContent(content: String) {
        desiredContent = content
        if (isReady && content != lastPushedContent) pushContent(content)
    }

    fun setTheme(theme: String) {
        desiredTheme = theme
        if (isReady && theme != currentTheme) pushTheme(theme)
    }

    fun setLanguage(languageTag: String) {
        desiredLanguageTag = languageTag
        if (isReady && languageTag != currentLanguageTag) pushLanguage(languageTag)
    }

    fun setLocalization(localization: Localization) {
        this.localization = localization
        setLanguage(localization.effectiveLanguage.tag)
    }

    /** Feed the note universe (wikilink resolution/autocomplete) — a JSON
     *  Array<{id,title,modifiedMs,tags?}> string [editor.md:77]. */
    fun setNotes(notesJson: String) {
        desiredNotesJson = notesJson
        if (isReady) pushNotes(notesJson)
    }

    /** Register the base URL local `![](f)` images resolve against —
     *  Android passes `file://<notesRoot>/` [editor.md:121]. */
    fun setImageBaseUrl(base: String) {
        desiredImageBaseUrl = base
        if (isReady && base != currentImageBaseUrl) pushImageBaseUrl(base)
    }

    /** Adopt a remote sync update of the open note: selection/scroll-
     *  preserving, history-suppressed (contrast [setContent]) [sync.md:239].
     *  Updates the dedupe state so the adopted text isn't re-pushed. */
    fun applyExternalContent(markdown: String) {
        desiredContent = markdown
        lastPushedContent = markdown
        eval("window.FutoEditor && window.FutoEditor.applyExternalContent(${JSONObject.quote(markdown)});")
    }

    /** Insert `![](filename)` and wait until CodeMirror has applied the
     * transaction. Storage migration keeps its vault gate until this returns,
     * so migration cannot start in the post-save callback gap.
     * Callers enter on Main.immediate: dispatching another runnable here would
     * let cancellation unwind while a stale insertion remained queued.
     *
     * Bounded by [CAPTURE_DEADLINE_MS] — the same ceiling [captureContentAndWait]
     * holds a navigation exit to. This runs inside [EditorSession.runWork],
     * the mutex a NAVIGATE exit's `awaitPendingWork()` waits on, so an
     * unbounded wait here used to leave Back dead for as long as the renderer
     * stayed wedged — or forever, if it never answered at all (F3). A timeout
     * resumes `false`, the same answer a live `window.FutoEditor` returning
     * false already produces, so the caller's existing cleanup and failure
     * toast (`NotesStore.saveImageIntoVault`) apply unchanged. */
    internal suspend fun insertImageAndWait(
        filename: String,
        attachment: EditorAttachmentToken,
    ): Boolean = insertImageWithinDeadline(deadlineMs = CAPTURE_DEADLINE_MS) {
        suspendCancellableCoroutine { continuation ->
            val permit = EditorAttachmentOperationPermit(attachments, attachment)
            continuation.invokeOnCancellation { permit.cancel() }
            val insert = Runnable {
                if (!permit.mayRun()) {
                    if (continuation.isActive) continuation.resume(false)
                    return@Runnable
                }
                webView.evaluateJavascript(
                    """
                    (() => {
                      if (!window.FutoEditor) return false;
                      window.FutoEditor.insertImage(${JSONObject.quote(filename)});
                      return true;
                    })()
                    """.trimIndent(),
                ) { result ->
                    if (continuation.isActive) continuation.resume(result == "true")
                }
            }
            if (Looper.myLooper() != Looper.getMainLooper()) {
                if (continuation.isActive) continuation.resume(false)
                return@suspendCancellableCoroutine
            }
            insert.run()
        }
    }

    /**
     * Blur and read the live document for save-before-navigation.
     *
     * The attachment check prevents a delayed callback from supplying bytes
     * from whichever note adopts the shared WebView next — that, and only that,
     * is [EditorCaptureOutcome.NotOurs], the answer that refuses the exit. A
     * page with no document to read answers [EditorCaptureOutcome.NoLiveDocument]
     * instead, which lets the exit leave on the shell's own buffer; see
     * [editorExitBody] for why those are not the same answer.
     *
     * A renderer that is alive but too busy to answer inside the deadline is the
     * third refusing case, [EditorCaptureOutcome.TimedOut]; [captureWithinDeadline]
     * owns how it is told apart from a wedge.
     */
    internal suspend fun captureContentAndWait(
        attachment: EditorAttachmentToken,
    ): EditorCaptureOutcome {
        // No `initialized` yet: the bundle is still applying this shell's
        // config — for a big enough note, for a long time — so nothing is on
        // screen and there is nothing of the user's to lose. Answer without
        // touching the renderer at all.
        if (!isReady) return EditorCaptureOutcome.NoLiveDocument
        var rendererAnswered = { false }
        return captureWithinDeadline(
            deadlineMs = CAPTURE_DEADLINE_MS,
            startLivenessProbe = { rendererAnswered = startRendererLivenessProbe() },
            rendererAnswered = { rendererAnswered() },
        ) { awaitCapture(attachment) }
    }

    /**
     * Ask the renderer for nothing at all, and hand back a reader for whether it
     * got round to answering.
     *
     * Dispatched immediately before the capture so it sits AHEAD of it in the
     * renderer's task queue: an editor streaming a note's tail in idle slices
     * runs this between two of them and answers in milliseconds, while a JS
     * thread wedged inside one long synchronous parse runs neither. That is the
     * whole difference between [EditorCaptureOutcome.TimedOut] and
     * [EditorCaptureOutcome.NoLiveDocument] — see [captureWithinDeadline].
     *
     * Deliberately does NOT touch `window.FutoEditor`: this asks whether the JS
     * thread is turning over, not whether the bundle booted. A page that is
     * alive without an editor answers the capture itself, promptly, with
     * [EditorCaptureOutcome.NoLiveDocument].
     */
    private fun startRendererLivenessProbe(): () -> Boolean {
        // `evaluateJavascript` is main-thread-only, and an off-main capture is
        // already answered NotOurs by [awaitCapture]; probing there would crash
        // instead. Reporting "no answer" costs nothing — that path never reads it.
        if (Looper.myLooper() != Looper.getMainLooper()) return { false }
        val answered = AtomicBoolean(false)
        webView.evaluateJavascript("1") { answered.set(true) }
        return { answered.get() }
    }

    private suspend fun awaitCapture(
        attachment: EditorAttachmentToken,
    ): EditorCaptureOutcome =
        suspendCancellableCoroutine { continuation ->
            val permit = EditorAttachmentOperationPermit(attachments, attachment)
            continuation.invokeOnCancellation { permit.cancel() }
            val capture = Runnable {
                if (!permit.mayRun()) {
                    if (continuation.isActive) continuation.resume(EditorCaptureOutcome.NotOurs)
                    return@Runnable
                }
                webView.evaluateJavascript(
                    """
                    (() => {
                      if (!window.FutoEditor) return null;
                      window.FutoEditor.blur();
                      return window.FutoEditor.getContent();
                    })()
                    """.trimIndent(),
                ) { result ->
                    // The deadline may already have answered for us. Returning
                    // here is what makes a late callback harmless: the stale
                    // bytes never reach [lastPushedContent].
                    if (!continuation.isActive) return@evaluateJavascript
                    if (!attachments.permits(attachment)) {
                        continuation.resume(EditorCaptureOutcome.NotOurs)
                        return@evaluateJavascript
                    }
                    val captured = decodeJavascriptString(result)
                    if (captured == null) {
                        // The page answered but has no `window.FutoEditor` —
                        // the legacy-WebView notice, or a boot that failed.
                        continuation.resume(EditorCaptureOutcome.NoLiveDocument)
                        return@evaluateJavascript
                    }
                    lastPushedContent = captured
                    continuation.resume(EditorCaptureOutcome.Captured(captured))
                }
            }
            if (Looper.myLooper() != Looper.getMainLooper()) {
                if (continuation.isActive) continuation.resume(EditorCaptureOutcome.NotOurs)
                return@suspendCancellableCoroutine
            }
            capture.run()
        }

    /** Run a shared editor command (TOOLBAR_EXEC in markdownToolbar.ts). */
    fun exec(commandId: String) {
        eval("window.FutoEditor && window.FutoEditor.exec(${JSONObject.quote(commandId)});")
    }

    fun openFind() {
        findReportGate.opened()
        eval("window.FutoEditor && window.FutoEditor.openFind();")
    }

    fun setFindQuery(query: String) {
        findReportGate.queryChanged(query)
        eval("window.FutoEditor && window.FutoEditor.setFindQuery(${JSONObject.quote(query)});")
    }

    fun stepFind(delta: Int) {
        if (delta != -1 && delta != 1) return
        eval("window.FutoEditor && window.FutoEditor.stepFind($delta);")
    }

    fun closeFind() {
        findReportGate.closed()
        eval("window.FutoEditor && window.FutoEditor.closeFind();")
    }

    /** Blur the editor — drops the soft keyboard and (via the resulting focus
     *  message) hides the native toolbar. The toolbar's dismiss chevron. */
    fun blur() {
        eval("window.FutoEditor && window.FutoEditor.blur();")
    }

    /** Open an external link (`openUrl` bridge message) in the system browser —
     *  the counterpart of [shouldOverrideUrlLoading]'s interception, for links
     *  the editor posts instead of navigating. Scheme-guarded so a crafted note
     *  can't reach file:/javascript:/futo-asset: through this path. */
    private fun openExternalUrl(url: String) {
        val uri = runCatching { Uri.parse(url) }.getOrNull() ?: return
        when (uri.scheme?.lowercase()) {
            "http", "https", "mailto", "tel" -> Unit
            else -> return
        }
        try {
            appContext.startActivity(
                Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        } catch (e: Exception) {
            Log.w("FutoEditor", "No app to open external URL $url", e)
        }
    }

    private fun pushContent(content: String) {
        lastPushedContent = content
        eval("window.FutoEditor && window.FutoEditor.setContent(${JSONObject.quote(content)});")
    }

    private fun pushTheme(theme: String) {
        currentTheme = theme
        eval("window.FutoEditor && window.FutoEditor.setTheme(${JSONObject.quote(theme)});")
    }

    private fun pushLanguage(languageTag: String) {
        currentLanguageTag = languageTag
        eval(
            "window.FutoEditor && window.FutoEditor.setLanguage && " +
                "window.FutoEditor.setLanguage(${JSONObject.quote(languageTag)});",
        )
    }

    private fun pushNotes(notesJson: String) {
        val hash = notesJson.hashCode()
        if (hash == lastNotesJsonHash) return
        lastNotesJsonHash = hash
        eval("window.FutoEditor && window.FutoEditor.setNotes(${JSONObject.quote(notesJson)});")
    }

    private fun pushImageBaseUrl(base: String) {
        currentImageBaseUrl = base
        eval("window.FutoEditor && window.FutoEditor.setImageBaseUrl(${JSONObject.quote(base)});")
    }

    /**
     * Focus the editor the way the app itself does — BOTH halves, in this order.
     * The quick-capture open ([attach] with `autoFocus`) is the UI caller; the
     * debug `focus-editor` hook (MainActivity.testHooks) is the automation one,
     * so a harness cannot get a weaker focus than a user does.
     */
    internal fun focusEditor() {
        // CM6 DOM focus alone does NOT bind Android's IME to the WebView, so a
        // programmatic open (the FAB quick-capture path, where autoFocus routes
        // here instead of a native field) sets the cursor but never raises the
        // soft keyboard — the user has to tap the body to type. Give the WebView
        // native focus, then show the IME. [list.md — quick capture]
        //
        // Chromium also WITHHOLDS the DOM focus event while the document itself
        // is unfocused, so the JS half alone leaves `.cm-focused` unset and
        // `document.hasFocus()` false however long you wait — measured, not
        // assumed. The native half below is what lets the pending focus land.
        eval("window.FutoEditor && window.FutoEditor.focus();")
        webView.post {
            webView.requestFocus()
            // WebView registers itself as the IMM's "served view" asynchronously
            // (focus proxies down through the Chromium content layer), so a single
            // showSoftInput races ahead of that registration and is silently
            // dropped ("Ignoring showSoftInput() … is not served"). Retry over
            // ~0.6s until the show lands; showSoftInput is idempotent once the
            // keyboard is up, so extra calls are harmless.
            showKeyboardWhenServed(tries = 8)
        }
    }

    /** Retry `showSoftInput` until the WebView is the IMM's served view (see
     *  [focusEditor]). Each tick re-checks focus and re-fires the show; stops
     *  after [tries] ticks so it can't loop forever if focus is lost. */
    private fun showKeyboardWhenServed(tries: Int) {
        if (tries <= 0 || !webView.hasFocus()) return
        val imm = appContext.getSystemService(Context.INPUT_METHOD_SERVICE)
            as? android.view.inputmethod.InputMethodManager
        imm?.showSoftInput(webView, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
        main.postDelayed({ showKeyboardWhenServed(tries - 1) }, 80)
    }

    private fun eval(js: String) {
        webView.post { webView.evaluateJavascript(js, null) }
    }

    companion object {
        /** Left/right inset of the note body, sent to the bundle in the host
         *  config so it lines up with this shell's native title field. */
        private const val CONTENT_PADDING_INLINE_PX = 16

        /**
         * How long an exit waits for the renderer to answer before giving up on
         * it — what keeps an exit FINITE.
         *
         * `evaluateJavascript` runs in the renderer process, so a JS thread
         * stuck inside a parse never calls the callback at all. The navigation
         * exit holds the interaction lock while it waits, which with no
         * deadline leaves Back simply dead — a worse trap than the toast. Six
         * seconds is far longer than any real capture (milliseconds; low
         * seconds on a low-end phone for a multi-megabyte note, whose
         * serialization is the cost) and far shorter than a wedge, which does
         * not end.
         */
        private const val CAPTURE_DEADLINE_MS = 6_000L

        @Volatile
        private var instance: EditorHost? = null

        /** Get (creating + pre-warming on first call) the shared editor host. */
        fun get(context: Context): EditorHost =
            instance ?: synchronized(this) {
                instance ?: EditorHost(context.applicationContext).also { instance = it }
            }

        /** Kick off WebView creation + bundle load early (e.g. app start) so the
         *  editor is warm before the first note-open. Must run on the main thread. */
        fun prewarm(context: Context) {
            get(context)
        }
    }
}

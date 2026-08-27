package com.futo.notes.ui

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
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

/**
 * Compose host for the embedded markdown editor — the Android counterpart of
 * the iOS `EditorWebView.swift`. Loads the SAME `editor.html` bundle (staged
 * into assets) and speaks the identical `futoBridge` contract:
 *
 *   - editor → host: messages posted to `window.futoBridge.postMessage(json)`
 *     (the injected `@JavascriptInterface`) — `ready` / `change` / `focus` /
 *     `openNote` / `pickImage` (bridge v2) / `cursorContext` (bridge v3) /
 *     `openUrl` (bridge v6) / `initialized` + `bridgeVersionMismatch`
 *     (bridge v7).
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
    private var autoFocus = false

    // Reactive inputs for the NATIVE Compose toolbar (EditorToolbar.kt), fed by
    // bridge messages — the Android counterpart of iOS's EditorToolbarState.
    /** Editor has focus (soft keyboard up) — the toolbar shows only then. */
    var editorFocused by mutableStateOf(false)
        private set
    /** Cursor is on a list line — shows the Indent/Outdent items. */
    var onListLine by mutableStateOf(false)
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

    private val main = Handler(Looper.getMainLooper())

    private val bridge = object {
        @JavascriptInterface
        fun postMessage(json: String) {
            val msg = runCatching { JSONObject(json) }.getOrNull() ?: return
            main.post { handle(msg) }
        }
    }

    private val appContext = appContext
    private var localization: Localization? = null

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
     * The bundle has parsed and mounted (`window.FutoEditor` exists) — the only
     * thing this gate decides, so once it is true there is nothing left to probe.
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
        WebView.setWebContentsDebuggingEnabled(true)
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

    private fun handle(msg: JSONObject) {
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
                // Only the bundle can send this, so it proves the engine ran it.
                // A shortcut, never the gate: the gate is the probe (see
                // [engineBooted]), which does not wait for the config round-trip.
                markEngineBooted()
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
            // Cursor moved on/off a list line — drives Indent/Outdent
            // visibility in the native toolbar (deduped editor-side).
            "cursorContext" -> onListLine = msg.optBoolean("onListLine")
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
        }
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
    ): EditorAttachmentToken {
        this.onChange = onChange
        this.onReady = onReady
        this.onOpenNote = onOpenNote
        this.onPickImage = onPickImage
        this.onSaveImageData = onSaveImageData
        this.autoFocus = autoFocus
        val token = attachments.attach()
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
        onChange = {}
        onReady = {}
        onOpenNote = {}
        onPickImage = {}
        onSaveImageData = { _, _ -> }
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
     * let cancellation unwind while a stale insertion remained queued. */
    internal suspend fun insertImageAndWait(
        filename: String,
        attachment: EditorAttachmentToken,
    ): Boolean =
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

    /** Blur and read the live CodeMirror document for save-before-navigation.
     * The attachment check prevents a delayed callback from supplying bytes
     * from whichever note adopts the shared WebView next. */
    internal suspend fun captureContentAndWait(
        attachment: EditorAttachmentToken,
    ): String? =
        suspendCancellableCoroutine { continuation ->
            val permit = EditorAttachmentOperationPermit(attachments, attachment)
            continuation.invokeOnCancellation { permit.cancel() }
            val capture = Runnable {
                if (!permit.mayRun()) {
                    if (continuation.isActive) continuation.resume(null)
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
                    if (!continuation.isActive) return@evaluateJavascript
                    if (!attachments.permits(attachment)) {
                        continuation.resume(null)
                        return@evaluateJavascript
                    }
                    val captured = decodeJavascriptString(result)
                    if (captured != null) lastPushedContent = captured
                    continuation.resume(captured)
                }
            }
            if (Looper.myLooper() != Looper.getMainLooper()) {
                if (continuation.isActive) continuation.resume(null)
                return@suspendCancellableCoroutine
            }
            capture.run()
        }

    /** Run a shared toolbar command (TOOLBAR_EXEC in markdownToolbar.ts) by
     *  manifest id — how the native toolbar's Exec items dispatch (bridge v3).
     *  Editing semantics stay single-source in TS; Kotlin never reimplements. */
    fun exec(commandId: String) {
        eval("window.FutoEditor && window.FutoEditor.exec(${JSONObject.quote(commandId)});")
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

package com.futo.notes.ui

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
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
import org.json.JSONObject

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
 *     `openNote` / `pickImage` (bridge v2) / `cursorContext` (bridge v3).
 *   - host → editor: `window.FutoEditor.setContent/getContent/focus/setTheme/
 *     setNotes/applyExternalContent/insertImage/setImageBaseUrl` plus the
 *     bridge-v3 native-toolbar calls `exec/blur/setNativeToolbar` via
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
 * a single `setContent` call — no boot on the open path. Reuse is safe because
 * the nav stack never holds two editors at once (List/Search ↔ Editor only),
 * so exactly one note binds the shared WebView at a time.
 */
@Composable
fun EditorWebView(
    content: String,
    theme: String,
    autoFocus: Boolean,
    onChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    notesJson: String? = null,
    imageBaseUrl: String? = null,
    onOpenNote: (String) -> Unit = {},
    onPickImage: (String) -> Unit = {},
    onSaveImageData: (String, String) -> Unit = { _, _ -> },
    onReady: () -> Unit = {},
) {
    val context = LocalContext.current
    val host = remember { EditorHost.get(context) }

    // Push the latest content/theme/notes/image-base on every (re)composition.
    // All are deduped + ready-gated inside the host, so this is cheap and won't
    // re-push our own change echoes (the editor swallows setContent echoes).
    host.setTheme(theme)
    host.setContent(content)
    if (notesJson != null) host.setNotes(notesJson)
    if (imageBaseUrl != null) host.setImageBaseUrl(imageBaseUrl)

    // Bind this note's callbacks for the lifetime of this composition. The
    // generation token guards against a future nav change attaching a new
    // note before this one's onDispose runs (it would otherwise clobber the
    // newer binding).
    DisposableEffect(Unit) {
        val token =
            host.attach(autoFocus, onChange, onReady, onOpenNote, onPickImage, onSaveImageData)
        onDispose { host.detach(token) }
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

    private var isReady = false
    private var currentTheme: String? = null
    private var lastPushedContent: String? = null
    private var desiredTheme: String = "light"
    private var desiredContent: String = ""
    // Note universe + image base (bridge v2). The notes JSON can be large, so
    // dedupe holds only its hash, not the string.
    private var desiredNotesJson: String? = null
    private var lastNotesJsonHash: Int? = null
    private var desiredImageBaseUrl: String? = null
    private var currentImageBaseUrl: String? = null

    // Incremented per attach; detach only clears if its token is still current.
    private var generation = 0

    private val main = Handler(Looper.getMainLooper())

    private val bridge = object {
        @JavascriptInterface
        fun postMessage(json: String) {
            val msg = runCatching { JSONObject(json) }.getOrNull() ?: return
            main.post { handle(msg) }
        }
    }

    private val appContext = appContext

    /** Bumped each time [webView] is rebuilt after a renderer-process death, so
     *  the [EditorWebView] composable re-adopts the fresh instance (key()). */
    var recreations by mutableStateOf(0)
        private set

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
        }
        loadUrl("file:///android_asset/editor.html")
    }

    var webView: WebView = createWebView()
        private set

    /** Replace the dead WebView with a fresh one and re-arm the editor state.
     *  Must run on the main thread. The renderer is gone, so the old instance
     *  is destroyed; the new one reloads editor.html and re-pushes content on
     *  its 'ready'. */
    private fun rebuildWebView() {
        val dead = webView
        (dead.parent as? ViewGroup)?.removeView(dead)
        dead.destroy()
        // Reset readiness + dedupe so the fresh editor gets a full re-push.
        isReady = false
        currentTheme = null
        lastPushedContent = null
        lastNotesJsonHash = null
        currentImageBaseUrl = null
        webView = createWebView()
        recreations++
    }

    private fun handle(msg: JSONObject) {
        when (msg.optString("type")) {
            "ready" -> {
                isReady = true
                // Suppress the embed's web toolbar — this shell renders the
                // native Compose toolbar (EditorToolbar.kt) [editor.md].
                eval("window.FutoEditor && window.FutoEditor.setNativeToolbar(true);")
                pushTheme(desiredTheme)
                pushContent(desiredContent)
                desiredImageBaseUrl?.let { pushImageBaseUrl(it) }
                desiredNotesJson?.let { pushNotes(it) }
                onReady()
                if (autoFocus) focusEditor()
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

    /** Bind a note's callbacks. Returns a token for the matching [detach].
     *  If the editor is already warm, fires [onReady] (and focuses) now so the
     *  "ready for this note" contract holds for reused opens too. */
    fun attach(
        autoFocus: Boolean,
        onChange: (String) -> Unit,
        onReady: () -> Unit,
        onOpenNote: (String) -> Unit = {},
        onPickImage: (String) -> Unit = {},
        onSaveImageData: (String, String) -> Unit = { _, _ -> },
    ): Int {
        this.onChange = onChange
        this.onReady = onReady
        this.onOpenNote = onOpenNote
        this.onPickImage = onPickImage
        this.onSaveImageData = onSaveImageData
        this.autoFocus = autoFocus
        if (isReady) {
            onReady()
            if (autoFocus) focusEditor()
        }
        return ++generation
    }

    /** Unbind, unless a newer [attach] has already taken over. */
    fun detach(token: Int) {
        if (token != generation) return
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

    fun setContent(content: String) {
        desiredContent = content
        if (isReady && content != lastPushedContent) pushContent(content)
    }

    fun setTheme(theme: String) {
        desiredTheme = theme
        if (isReady && theme != currentTheme) pushTheme(theme)
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

    /** Insert `![](filename)` at the cursor — called after a pickImage
     *  round-trip saves the image into the vault root. */
    fun insertImage(filename: String) {
        eval("window.FutoEditor && window.FutoEditor.insertImage(${JSONObject.quote(filename)});")
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

    private fun pushContent(content: String) {
        lastPushedContent = content
        eval("window.FutoEditor && window.FutoEditor.setContent(${JSONObject.quote(content)});")
    }

    private fun pushTheme(theme: String) {
        currentTheme = theme
        eval("window.FutoEditor && window.FutoEditor.setTheme(${JSONObject.quote(theme)});")
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

    private fun focusEditor() = eval("window.FutoEditor && window.FutoEditor.focus();")

    private fun eval(js: String) {
        webView.post { webView.evaluateJavascript(js, null) }
    }

    companion object {
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

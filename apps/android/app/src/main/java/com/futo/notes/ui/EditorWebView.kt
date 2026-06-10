package com.futo.notes.ui

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import org.json.JSONObject

/**
 * Compose host for the embedded markdown editor — the Android counterpart of
 * the iOS `EditorWebView.swift`. Loads the SAME `editor.html` bundle (staged
 * into assets) and speaks the identical `futoBridge` contract:
 *
 *   - editor → host: messages posted to `window.futoBridge.postMessage(json)`
 *     (the injected `@JavascriptInterface`) — `ready` / `change` / `focus` /
 *     `openNote` / `pickImage` (bridge v2).
 *   - host → editor: `window.FutoEditor.setContent/getContent/focus/setTheme/
 *     setNotes/applyExternalContent/insertImage/setImageBaseUrl` via
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
        val token = host.attach(autoFocus, onChange, onReady, onOpenNote, onPickImage)
        onDispose { host.detach(token) }
    }

    AndroidView(
        modifier = modifier,
        // The host owns the WebView for the whole app lifetime; detach it from
        // its previous Compose holder before this composition adopts it.
        factory = {
            (host.webView.parent as? ViewGroup)?.removeView(host.webView)
            host.webView
        },
    )
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
    private var autoFocus = false

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

    @SuppressLint("SetJavaScriptEnabled")
    val webView: WebView = WebView(appContext).apply {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        // Required twice over: editor.html itself is a file:// asset, and local
        // note images render from file://<notesRoot>/ (setImageBaseUrl). Do not
        // remove [editor.md:121].
        settings.allowFileAccess = true
        setBackgroundColor(android.graphics.Color.TRANSPARENT)
        WebView.setWebContentsDebuggingEnabled(true)
        addJavascriptInterface(bridge, "futoBridge")
        webViewClient = WebViewClient()
        loadUrl("file:///android_asset/editor.html")
    }

    private fun handle(msg: JSONObject) {
        when (msg.optString("type")) {
            "ready" -> {
                isReady = true
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
            "focus" -> { /* keyboard handled natively by adjustResize */ }
            // User tapped a RESOLVED wikilink — id is the target note's id
            // (vault-relative path sans .md) [editor.md:77].
            "openNote" -> onOpenNote(msg.optString("id"))
            // User tapped a toolbar image button; the host runs the native
            // picker and calls back via insertImage [editor.md:121].
            "pickImage" -> onPickImage(msg.optString("source"))
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
    ): Int {
        this.onChange = onChange
        this.onReady = onReady
        this.onOpenNote = onOpenNote
        this.onPickImage = onPickImage
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
        autoFocus = false
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

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
 *     (the injected `@JavascriptInterface`) — `ready` / `change` / `focus`.
 *   - host → editor: `window.FutoEditor.setContent/getContent/focus/setTheme`
 *     via `evaluateJavascript`.
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
    onReady: () -> Unit = {},
) {
    val context = LocalContext.current
    val host = remember { EditorHost.get(context) }

    // Push the latest content/theme on every (re)composition. Both are
    // deduped + ready-gated inside the host, so this is cheap and won't
    // re-push our own change echoes (the editor swallows setContent echoes).
    host.setTheme(theme)
    host.setContent(content)

    // Bind this note's callbacks for the lifetime of this composition. The
    // generation token guards against a future nav change attaching a new
    // note before this one's onDispose runs (it would otherwise clobber the
    // newer binding).
    DisposableEffect(Unit) {
        val token = host.attach(autoFocus, onChange, onReady)
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
    private var autoFocus = false

    private var isReady = false
    private var currentTheme: String? = null
    private var lastPushedContent: String? = null
    private var desiredTheme: String = "light"
    private var desiredContent: String = ""

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
                onReady()
                if (autoFocus) focusEditor()
            }
            "change" -> {
                val c = msg.optString("content")
                lastPushedContent = c
                onChange(c)
            }
            "focus" -> { /* keyboard handled natively by adjustResize */ }
        }
    }

    /** Bind a note's callbacks. Returns a token for the matching [detach].
     *  If the editor is already warm, fires [onReady] (and focuses) now so the
     *  "ready for this note" contract holds for reused opens too. */
    fun attach(autoFocus: Boolean, onChange: (String) -> Unit, onReady: () -> Unit): Int {
        this.onChange = onChange
        this.onReady = onReady
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

    private fun pushContent(content: String) {
        lastPushedContent = content
        eval("window.FutoEditor && window.FutoEditor.setContent(${JSONObject.quote(content)});")
    }

    private fun pushTheme(theme: String) {
        currentTheme = theme
        eval("window.FutoEditor && window.FutoEditor.setTheme(${JSONObject.quote(theme)});")
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

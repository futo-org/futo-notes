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
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
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
 *     (bridge v7) / `formatState` (unversioned, Milkdown engine only — see
 *     bridge.ts's BRIDGE_VERSION doc comment).
 *   - host → editor: `window.FutoEditor.initialize` (bridge v7 — the whole boot
 *     config in one call) plus `setContent/flush/focus/setTheme/setNotes/
 *     applyExternalContent/insertImage/setImageBaseUrl` and the bridge-v3
 *     native-toolbar calls `exec/blur/setNativeToolbar`, via
 *     `evaluateJavascript`.
 *
 * The WebView is NOT created per note-open. A cold WebView boot (Chromium
 * renderer start + parse/exec of the ~2 MB editor bundle + Milkdown mount)
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
    noteId: String,
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
    onDocumentLoaded: (String) -> Unit = {},
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
        host.setContent(noteId, content)
        if (notesJson != null) host.setNotes(notesJson)
        if (imageBaseUrl != null) host.setImageBaseUrl(imageBaseUrl)
    }

    // Bind this note's callbacks for the lifetime of this composition. The
    // generation token guards against a future nav change attaching a new
    // note before this one's onDispose runs (it would otherwise clobber the
    // newer binding).
    DisposableEffect(noteId) {
        val token = host.attach(
            noteId,
            autoFocus,
            onChange,
            onReady,
            onDocumentLoaded,
            onOpenNote,
            onPickImage,
            onSaveImageData,
            onPasteClipboardImage,
            onFindMatches,
        )
        attachment = token
        host.setTheme(theme)
        host.setLanguage(languageTag)
        host.setContent(noteId, content)
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
    internal val mailbox = EditorMailbox()
    internal var desiredNoteId = ""
    internal var lastPushedNoteId: String? = null
    internal val pushed = mutableMapOf<String, String>()
    internal val externalPushed = mutableMapOf<String, String>()
    internal val adoptions = mutableMapOf<String, CompletableDeferred<Boolean>>()
    internal var onDocumentLoaded: (String) -> Unit = {}
    internal var onReady: () -> Unit = {}
    internal var onOpenNote: (String) -> Unit = {}
    internal var onPickImage: (String) -> Unit = {}
    internal var onSaveImageData: (String, String) -> Unit = { _, _ -> }
    internal var onPasteClipboardImage: () -> Unit = {}
    internal var onFindMatches: (FindMatchesReport) -> Unit = {}
    internal var autoFocus = false
    internal val renameHandover = EditorRenameHandover()

    // Reactive inputs for the NATIVE Compose toolbar (EditorToolbar.kt), fed by
    // bridge messages — the Android counterpart of iOS's EditorToolbarState.
    /** Editor has focus (soft keyboard up) — the toolbar shows only then. */
    var editorFocused by mutableStateOf(false)
        internal set
    /**
     * Cursor is on a list line specifically. [inContainer] is what actually
     * gates the Indent/Outdent items now; this stays only as the fallback for
     * a bundle old enough to have never sent `inContainer` at all.
     */
    var onListLine by mutableStateOf(false)
        internal set
    /**
     * Cursor is in a list item OR a blockquote (bridge `cursorContext.
     * inContainer`) — shows the Indent/Outdent items. `null` means the
     * message hasn't carried this field at all (an older bundle); the
     * toolbar then falls back to [onListLine], exactly today's behavior for
     * that bundle.
     */
    var inContainer by mutableStateOf<Boolean?>(null)
        internal set
    /**
     * Toolbar-manifest ids active at the cursor/selection (bridge
     * `formatState`) — drives the Notion-style highlighted button state in
     * EditorToolbar.kt, the counterpart of iOS's EditorToolbarState. Empty on
     * editors that never send `formatState` (the CodeMirror engine), so no
     * button lights up there.
     */
    var activeFormats by mutableStateOf<Set<String>>(emptySet())
        internal set

    /**
     * Toolbar-manifest ids that are currently INERT (bridge
     * `formatState.disabled`) — today only `undo`/`redo` with an empty
     * prosemirror-history stack. Same message, same dedupe as
     * [activeFormats]; the counterpart is iOS's
     * `EditorToolbarState.disabledFormats` (EditorToolbar.swift).
     */
    var disabledFormats by mutableStateOf<Set<String>>(emptySet())
        internal set

    /** The bundle has applied this shell's host config and the note is on
     *  screen (the `initialized` message) — not merely that the page loaded. */
    internal var isReady = false

    // What this shell last SENT the bundle, so a recomposition per keystroke
    // (the composable pushes on every one) does not become an
    // evaluateJavascript per keystroke carrying the whole note universe (M5).
    // Purely a transport gate — what counts as a change, and what the editor
    // does about it, is decided in packages/editor/src/hostBoot.ts. iOS keeps
    // the same gate for the same reason; the right way to retire both is to
    // stop pushing from a composition body, not to delete the compares.
    internal var currentTheme: String? = null
    internal var currentLanguageTag: String? = null
    internal var lastPushedContent: String? = null
    internal var desiredTheme: String = "light"
    internal var desiredLanguageTag: String = "en"
    internal var desiredContent: String = ""
    // Note universe + image base (bridge v2). The notes JSON can be large, so
    // dedupe holds only its hash, not the string.
    internal var desiredNotesJson: String? = null
    internal var lastNotesJsonHash: Int? = null
    internal var desiredImageBaseUrl: String? = null
    internal var currentImageBaseUrl: String? = null

    internal val attachments = EditorAttachmentGate()
    internal val findReportGate = FindReportGate()
    internal val main = Handler(Looper.getMainLooper())

    internal val bridge = object {
        @JavascriptInterface
        fun postMessage(json: String) {
            val msg = runCatching { JSONObject(json) }.getOrNull() ?: return
            main.post { handle(msg) }
        }
    }

    internal val appContext = appContext
    internal var localization: Localization? = null

    /** Stable across rotation, fresh after process death. */
    val processToken: String = UUID.randomUUID().toString()

    /** Bumped each time [webView] is rebuilt after a renderer-process death, so
     *  the [EditorWebView] composable re-adopts the fresh instance (key()). */
    var recreations by mutableStateOf(0)
        internal set

    /**
     * Why this WebView's engine can't run the editor bundle, or null while
     * nothing says it can't — the boot OUTCOME, not a version number
     * (EditorEngineSupport.kt). Because the host is pre-warmed at app start
     * ([prewarm]), it is already decided by the first note-open; the editor
     * screen reads it to swap in [LegacyWebViewNotice] instead of a blank pane.
     */
    var engineFailure by mutableStateOf<String?>(null)
        internal set

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
    internal var engineBooted = false

    /** The post-grace-period probe (see [ENGINE_BOOT_GRACE_MS]). Held as one
     *  Runnable so a boot or a rebuild can cancel it — left queued, it would
     *  keep a destroyed WebView alive for the rest of the grace period. */
    internal val graceProbe = Runnable { probeEngine(isFinal = true) }

    var webView: WebView = createWebView()
        internal set

    companion object {
        /** Left/right inset of the note body, sent to the bundle in the host
         *  config so it lines up with this shell's native title field. */
        internal const val CONTENT_PADDING_INLINE_PX = 16

        /** Bound image insertion when the renderer is busy or unavailable. */
        internal const val INSERT_IMAGE_DEADLINE_MS = 6_000L

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

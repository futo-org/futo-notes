package com.futo.notes.ui

import android.annotation.SuppressLint
import android.content.Intent
import android.util.Log
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import com.futo.notes.BuildConfig

@SuppressLint("SetJavaScriptEnabled")
internal fun EditorHost.createWebView(): WebView = WebView(appContext).apply {
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
    // via setNotes, tagged document reports name every note, `change`
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
            main.post {
                // A dead renderer answers nothing: the read it held is over.
                mailbox.rendererGone()
                adoptions.values.forEach { it.complete(false) }
                rebuildWebView()
            }
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
    loadUrl("file:///android_asset/editor.html" + if (BuildConfig.DEBUG) "?test" else "")
}

/** Ask the page whether the editor bundle mounted, and record any failure.
 *  Nothing to ask once the answer is in either direction — a recorded failure
 *  is only ever cleared by a later boot or a rebuild. */
internal fun EditorHost.probeEngine(isFinal: Boolean) {
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
internal fun EditorHost.rescueEngineVerdict() {
    if (engineBooted || engineFailure == null) return
    val probed = webView
    probed.evaluateJavascript(ENGINE_PROBE_JS) { raw ->
        if (probed !== webView) return@evaluateJavascript
        if (editorEngineBooted(decodeJavascriptString(raw))) markEngineBooted()
    }
}

/** This engine runs the editor, whatever its provider calls itself: stop
 *  probing, and disprove any failure a slow boot had already earned. */
internal fun EditorHost.markEngineBooted() {
    engineBooted = true
    main.removeCallbacks(graceProbe)
    engineFailure = null
}

/** Replace the dead WebView with a fresh one and re-arm the editor state.
 *  Must run on the main thread. The renderer is gone, so the old instance
 *  is destroyed; the new one reloads editor.html and gets the same host
 *  config on its 'ready', which restores the open note.
 *
 *  Nothing but readiness and the engine verdict needs resetting — the config
 *  is applied unconditionally, so the dedupe markers [sendHostConfig] sets
 *  are correct for the fresh page too. */
internal fun EditorHost.rebuildWebView() {
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

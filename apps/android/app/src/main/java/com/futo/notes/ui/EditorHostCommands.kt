package com.futo.notes.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.webkit.WebView
import org.json.JSONObject

/** Run a shared editor command (toolbarExec.ts in src/features/editor/milkdown). */
fun EditorHost.exec(commandId: String) {
    eval("window.FutoEditor && window.FutoEditor.exec(${JSONObject.quote(commandId)});")
}

fun EditorHost.openFind() {
    findReportGate.opened()
    eval("window.FutoEditor && window.FutoEditor.openFind();")
}

fun EditorHost.setFindQuery(query: String) {
    findReportGate.queryChanged(query)
    eval("window.FutoEditor && window.FutoEditor.setFindQuery(${JSONObject.quote(query)});")
}

fun EditorHost.stepFind(delta: Int) {
    if (delta != -1 && delta != 1) return
    eval("window.FutoEditor && window.FutoEditor.stepFind($delta);")
}

fun EditorHost.closeFind() {
    findReportGate.closed()
    eval("window.FutoEditor && window.FutoEditor.closeFind();")
}

/** Blur the editor — drops the soft keyboard and (via the resulting focus
 *  message) hides the native toolbar. The toolbar's dismiss chevron. */
fun EditorHost.blur() {
    eval("window.FutoEditor && window.FutoEditor.blur();")
}

/** Open an external link (`openUrl` bridge message) in the system browser —
 *  the counterpart of [shouldOverrideUrlLoading]'s interception, for links
 *  the editor posts instead of navigating. Scheme-guarded so a crafted note
 *  can't reach file:/javascript:/futo-asset: through this path. */
internal fun EditorHost.openExternalUrl(url: String) {
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

internal fun EditorHost.pushContent(content: String) {
    lastPushedContent = content
    lastPushedNoteId = desiredNoteId
    pushed[desiredNoteId] = content
    eval("window.FutoEditor && window.FutoEditor.setContent(${JSONObject.quote(desiredNoteId)}, ${JSONObject.quote(content)});")
}

internal fun EditorHost.pushTheme(theme: String) {
    currentTheme = theme
    eval("window.FutoEditor && window.FutoEditor.setTheme(${JSONObject.quote(theme)});")
}

internal fun EditorHost.pushLanguage(languageTag: String) {
    currentLanguageTag = languageTag
    eval(
        "window.FutoEditor && window.FutoEditor.setLanguage && " +
            "window.FutoEditor.setLanguage(${JSONObject.quote(languageTag)});",
    )
}

internal fun EditorHost.pushNotes(notesJson: String) {
    val hash = notesJson.hashCode()
    if (hash == lastNotesJsonHash) return
    lastNotesJsonHash = hash
    eval("window.FutoEditor && window.FutoEditor.setNotes(${JSONObject.quote(notesJson)});")
}

internal fun EditorHost.pushImageBaseUrl(base: String) {
    currentImageBaseUrl = base
    eval("window.FutoEditor && window.FutoEditor.setImageBaseUrl(${JSONObject.quote(base)});")
}

/**
 * Focus the editor the way the app itself does — BOTH halves, in this order.
 * The quick-capture open ([attach] with `autoFocus`) is the UI caller; the
 * debug `focus-editor` hook (MainActivity.testHooks) is the automation one,
 * so a harness cannot get a weaker focus than a user does.
 */
internal fun EditorHost.focusEditor() {
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
internal fun EditorHost.showKeyboardWhenServed(tries: Int) {
    if (tries <= 0 || !webView.hasFocus()) return
    val imm = appContext.getSystemService(Context.INPUT_METHOD_SERVICE)
        as? android.view.inputmethod.InputMethodManager
    imm?.showSoftInput(webView, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
    main.postDelayed({ showKeyboardWhenServed(tries - 1) }, 80)
}

internal fun EditorHost.eval(js: String) {
    webView.post { webView.evaluateJavascript(js, null) }
}

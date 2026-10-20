package com.futo.notes.ui

import android.os.Looper
import android.webkit.WebView
import androidx.compose.runtime.key
import com.futo.notes.localization.Localization
import com.futo.notes.ui.EditorHost.Companion.CONTENT_PADDING_INLINE_PX
import com.futo.notes.ui.EditorHost.Companion.INSERT_IMAGE_DEADLINE_MS
import kotlin.coroutines.resume
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject

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
internal fun EditorHost.sendHostConfig() {
    val config = JSONObject().apply {
        put("bridgeVersion", BridgeSpec.BRIDGE_VERSION)
        put("theme", desiredTheme)
        put("languageTag", desiredLanguageTag)
        put("noteId", desiredNoteId)
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
    lastPushedNoteId = desiredNoteId
    pushed[desiredNoteId] = desiredContent
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
internal fun EditorHost.attach(
    noteId: String,
    autoFocus: Boolean,
    onChange: (String) -> Unit,
    onReady: () -> Unit,
    onDocumentLoaded: (String) -> Unit = {},
    onOpenNote: (String) -> Unit = {},
    onPickImage: (String) -> Unit = {},
    onSaveImageData: (String, String) -> Unit = { _, _ -> },
    onPasteClipboardImage: () -> Unit = {},
    onFindMatches: (FindMatchesReport) -> Unit = {},
): EditorAttachmentToken {
    this.onReady = onReady
    this.onDocumentLoaded = onDocumentLoaded
    this.onOpenNote = onOpenNote
    this.onPickImage = onPickImage
    this.onSaveImageData = onSaveImageData
    this.onPasteClipboardImage = onPasteClipboardImage
    this.onFindMatches = onFindMatches
    this.autoFocus = autoFocus
    val token = attachments.attach()
    mailbox.bind(token.generation, noteId, onChange)
    // A rename's re-key keeps the focused editor as it is: re-running the
    // open-time focus blurs and refocuses the page, and an IME commit in
    // that window never reaches the document.
    val continuesRename = renameHandover.consume(noteId)
    if (!continuesRename) editorFocused = false
    if (isReady) {
        onReady()
        if (autoFocus && !continuesRename) focusEditor()
    }
    return token
}

/** Unbind, unless a newer [attach] has already taken over. */
internal fun EditorHost.detach(token: EditorAttachmentToken) {
    mailbox.detach(token.generation)
    pruneDocumentReports()
    if (!attachments.permits(token)) return
    attachments.detach(token)
    onReady = {}
    onDocumentLoaded = {}
    onOpenNote = {}
    onPickImage = {}
    onSaveImageData = { _, _ -> }
    onPasteClipboardImage = {}
    onFindMatches = {}
    autoFocus = false
    // Leaving the editor screen detaches the WebView without a blur event;
    // clear the flag so a reopened note doesn't flash a stale toolbar. A
    // rename's re-key (see [EditorRenameHandover]) is not leaving.
    if (!renameHandover.pending) editorFocused = false
}

internal fun EditorHost.currentAttachment(): EditorAttachmentToken? = attachments.current()

internal fun EditorHost.isCurrentAttachment(token: EditorAttachmentToken): Boolean =
    attachments.permits(token)

fun EditorHost.setContent(noteId: String, content: String) {
    desiredNoteId = noteId
    desiredContent = content
    if (isReady && (noteId != lastPushedNoteId || content != lastPushedContent)) pushContent(content)
}

fun EditorHost.setTheme(theme: String) {
    desiredTheme = theme
    if (isReady && theme != currentTheme) pushTheme(theme)
}

fun EditorHost.setLanguage(languageTag: String) {
    desiredLanguageTag = languageTag
    if (isReady && languageTag != currentLanguageTag) pushLanguage(languageTag)
}

fun EditorHost.setLocalization(localization: Localization) {
    this.localization = localization
    setLanguage(localization.effectiveLanguage.tag)
}

/** Feed the note universe (wikilink resolution/autocomplete) — a JSON
 *  Array<{id,title,modifiedMs,tags?}> string [editor.md:77]. */
fun EditorHost.setNotes(notesJson: String) {
    desiredNotesJson = notesJson
    if (isReady) pushNotes(notesJson)
}

/** Register the base URL local `![](f)` images resolve against —
 *  Android passes `file://<notesRoot>/` [editor.md:121]. */
fun EditorHost.setImageBaseUrl(base: String) {
    desiredImageBaseUrl = base
    if (isReady && base != currentImageBaseUrl) pushImageBaseUrl(base)
}

/** Adopt a remote sync update of the open note: selection/scroll-
 *  preserving, history-suppressed (contrast [setContent]) [sync.md:239].
 *  Updates the dedupe state so the adopted text isn't re-pushed. */
internal suspend fun EditorHost.applyExternalContent(noteId: String, markdown: String, expectedGeneration: Long): Boolean {
    if (!isReady || noteId != desiredNoteId || adoptions.containsKey(noteId)) return false
    val answer = CompletableDeferred<Boolean>()
    adoptions[noteId] = answer
    externalPushed[noteId] = markdown
    try {
        eval("window.FutoEditor && window.FutoEditor.applyExternalContent(${JSONObject.quote(noteId)}, ${JSONObject.quote(markdown)}, $expectedGeneration);")
        val applied = withTimeoutOrNull(6_000L) { answer.await() } == true
        if (applied) { desiredContent = markdown; lastPushedContent = markdown }
        return applied
    } finally {
        if (adoptions[noteId] === answer) adoptions.remove(noteId)
        externalPushed.remove(noteId)
    }
}

internal suspend fun EditorHost.insertImageAndWait(
    filename: String,
    attachment: EditorAttachmentToken,
): Boolean = insertImageWithinDeadline(deadlineMs = INSERT_IMAGE_DEADLINE_MS) {
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

internal fun EditorHost.pruneDocumentReports() {
    mailbox.prune(desiredNoteId)
    pushed.keys.toList().filter { it != desiredNoteId && mailbox.current(it).canProceed }
        .forEach { pushed.remove(it) }
}

internal fun EditorHost.retainUnflushed(noteId: String, deliver: (String) -> Unit) {
    mailbox.retainUnflushed(noteId, deliver)
}

internal fun EditorHost.latest(noteId: String): EditorCurrent = mailbox.current(noteId)

internal fun EditorHost.prepareLoad(noteId: String) { mailbox.prepareLoad(noteId) }

/** Relabel the open note without pushing this shell's copy, which can lag a
 *  keystroke typed after the flush: the bundle reports its live document as
 *  [toId] through `change`. */
internal fun EditorHost.retarget(fromId: String, toId: String) {
    mailbox.retarget(fromId, toId)
    if (desiredNoteId != fromId) return
    desiredNoteId = toId
    pushed[fromId]?.let { pushed[toId] = it }
    if (!isReady || lastPushedNoteId != fromId) return
    lastPushedNoteId = toId
    renameHandover.begin(toId)
    eval("window.FutoEditor && window.FutoEditor.retarget(${JSONObject.quote(fromId)}, ${JSONObject.quote(toId)});")
}

internal suspend fun EditorHost.awaitLoaded(noteId: String, content: String): EditorCurrent =
    mailbox.awaitLoaded(noteId) { setContent(noteId, content) }

internal suspend fun EditorHost.awaitCurrent(noteId: String, deadlineMs: Long = 6_000L): EditorCurrent =
    mailbox.awaitCurrent(noteId, deadlineMs) { token ->
        eval("window.FutoEditor && window.FutoEditor.flush(${JSONObject.quote(token)});")
    }

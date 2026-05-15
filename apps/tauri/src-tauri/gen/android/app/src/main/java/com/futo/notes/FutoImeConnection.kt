package com.futo.notes

import android.os.Build
import android.os.Bundle
import android.text.TextUtils
import android.view.inputmethod.CompletionInfo
import android.view.inputmethod.CorrectionInfo
import android.view.inputmethod.ExtractedText
import android.view.inputmethod.ExtractedTextRequest
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.view.inputmethod.SurroundingText

/**
 * IME-shield InputConnection wrapper. DO NOT REMOVE without reading
 * docs/learnings/ime-shield-workaround.md.
 *
 * # Why this exists
 *
 * Chromium 147.0.7727.x (Android System WebView) crashes its renderer
 * process via SIGTRAP/TRAP_BRKPT inside `libwebviewchromium.so` when
 * certain IMEs — notably FUTO Keyboard's `RichInputConnection` — issue
 * surrounding-text queries against an empty editable. Stack:
 *
 *   - IME calls `InputConnection.getTextBeforeCursor` (or
 *     `getSurroundingText` / `GET_WORD_RANGE_AT_CURSOR`) on backspace,
 *     to figure out what to delete (emoji surrogate pairs, list markers,
 *     composing text). On an empty editable, the renderer's handler
 *     trips a CHECK() and dies.
 *   - The host process then takes the FATAL crashpad abort unless
 *     `onRenderProcessGone` claims to have handled it. See
 *     MainActivity.kt for that part.
 *
 * # What this class does
 *
 * Every IME read-query is answered locally from a Kotlin-side shadow of
 * the editor (see [EditorImeShield]) instead of round-tripping to the
 * renderer. The crash path is therefore unreachable — the IME never
 * causes Chromium to look at an empty editable, because Chromium isn't
 * asked at all.
 *
 * The shield is active only while the CodeMirror note body is focused.
 * Title inputs and other HTML editables delegate to Chromium normally.
 * While active, normal mutations (non-empty commitText, mid-document
 * deletion, etc.) flow through to the wrapped underlying InputConnection
 * unchanged. Empty-editor backspace and IME cleanup calls are
 * short-circuited because they are no-ops in the non-crashing case and
 * part of the Chromium crash path on affected devices.
 *
 * # Coverage
 *
 * All `InputConnection` read APIs that proxy to the renderer's text
 * service are intercepted. If a future Android API adds another read
 * method, add it here.
 *
 * # Sync model
 *
 * JS calls [EditorImeShield.update] via `@JavascriptInterface` on every
 * CM6 doc/selection change with a monotonic serial. If the shadow's
 * serial is "behind" the editor (the rare microsecond race after a doc
 * change but before JS has notified), reads return empty rather than
 * stale — empty is the *safe* answer for the bug we're avoiding.
 */
class FutoImeConnection(target: InputConnection) : InputConnectionWrapper(target, true) {

    private fun activeSnapshotOrNull(): EditorImeShield.Snapshot? {
        val s = EditorImeShield.snapshot()
        return if (s.active) s else null
    }

    // -------- Read queries: answered locally, never reach the renderer. --------

    override fun getTextBeforeCursor(n: Int, flags: Int): CharSequence? {
        val s = activeSnapshotOrNull() ?: return super.getTextBeforeCursor(n, flags)
        EditorImeShield.noteReadBefore()
        if (n <= 0) return ""
        val end = s.selStart.coerceAtLeast(0).coerceAtMost(s.text.length)
        val start = (end - n).coerceAtLeast(0)
        return s.text.substring(start, end)
    }

    override fun getTextAfterCursor(n: Int, flags: Int): CharSequence? {
        val s = activeSnapshotOrNull() ?: return super.getTextAfterCursor(n, flags)
        EditorImeShield.noteReadAfter()
        if (n <= 0) return ""
        val start = s.selEnd.coerceAtLeast(0).coerceAtMost(s.text.length)
        val end = (start + n).coerceAtMost(s.text.length)
        return s.text.substring(start, end)
    }

    override fun getSelectedText(flags: Int): CharSequence? {
        val s = activeSnapshotOrNull() ?: return super.getSelectedText(flags)
        EditorImeShield.noteSelectedText()
        val from = s.selStart.coerceAtLeast(0).coerceAtMost(s.text.length)
        val to = s.selEnd.coerceAtLeast(from).coerceAtMost(s.text.length)
        if (from == to) return null
        return s.text.substring(from, to)
    }

    override fun getCursorCapsMode(reqMode: Int): Int {
        activeSnapshotOrNull() ?: return super.getCursorCapsMode(reqMode)
        EditorImeShield.noteCapsMode()
        // Markdown-only editor, capsMode is irrelevant. Returning 0 is
        // valid per the API contract: "no capitalization in effect".
        return 0
    }

    override fun getExtractedText(request: ExtractedTextRequest?, flags: Int): ExtractedText? {
        val s = activeSnapshotOrNull() ?: return super.getExtractedText(request, flags)
        EditorImeShield.noteExtractedText()
        val et = ExtractedText()
        et.text = s.text
        et.startOffset = 0
        et.partialStartOffset = -1
        et.partialEndOffset = -1
        et.selectionStart = s.selStart.coerceAtLeast(0).coerceAtMost(s.text.length)
        et.selectionEnd = s.selEnd.coerceAtLeast(et.selectionStart).coerceAtMost(s.text.length)
        et.flags = 0
        return et
    }

    // API 31+ adds getSurroundingText.
    override fun getSurroundingText(
        beforeLength: Int,
        afterLength: Int,
        flags: Int
    ): SurroundingText? {
        val s = activeSnapshotOrNull() ?: return super.getSurroundingText(beforeLength, afterLength, flags)
        EditorImeShield.noteSurroundingText()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null
        val cursor = s.selStart.coerceAtLeast(0).coerceAtMost(s.text.length)
        val selEnd = s.selEnd.coerceAtLeast(cursor).coerceAtMost(s.text.length)
        val sliceStart = (cursor - beforeLength).coerceAtLeast(0)
        val sliceEnd = (selEnd + afterLength).coerceAtMost(s.text.length)
        val slice: CharSequence = s.text.substring(sliceStart, sliceEnd)
        val selectionStartInSlice = cursor - sliceStart
        val selectionEndInSlice = selEnd - sliceStart
        return SurroundingText(slice, selectionStartInSlice, selectionEndInSlice, sliceStart)
    }

    // -------- Deletion mutations: also short-circuit on empty doc. --------
    //
    // After Colt's "fix v1" repro on his Moto, the crash moved: with the
    // surrounding-text reads intercepted, FUTO Keyboard's next call on
    // backspace is `deleteSurroundingText(1, 0)`. That mutation goes to
    // Chromium's renderer too, and the renderer's empty-editable
    // deletion handler crashes on the same Android 11 / Chromium 147
    // build (a related CHECK to the read-path one, different code
    // location).
    //
    // Solution: when the shield says the doc is empty, treat any
    // delete-backward mutation as a no-op and return success. We do
    // NOT update CM6 or the shadow — there's nothing to delete and the
    // renderer would have no-op'd it too (in the non-crashing case).
    //
    // We deliberately keep this gated on shield-empty so normal
    // deletion mid-text still works: it passes through to the
    // underlying IC and the renderer handles it normally.

    /** True when the focused CM6 editor has zero text length. The IME's
     *  "delete" has nothing to delete in this state, so swallowing it is
     *  safe. When focus is in the title field or another HTML input this
     *  returns false and the call delegates normally. */
    private fun isActiveShadowEmpty(): Boolean = activeSnapshotOrNull()?.text?.isEmpty() == true

    override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
        if (isActiveShadowEmpty()) {
            EditorImeShield.noteEmptyDelete()
            return true
        }
        EditorImeShield.noteForwardedDelete()
        return super.deleteSurroundingText(beforeLength, afterLength)
    }

    override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean {
        if (isActiveShadowEmpty()) {
            EditorImeShield.noteEmptyDeleteCodePoints()
            return true
        }
        EditorImeShield.noteForwardedDelete()
        return super.deleteSurroundingTextInCodePoints(beforeLength, afterLength)
    }

    /** Some IMEs fall back to a synthetic KEYCODE_DEL when InputConnection
     *  deletion methods don't appear to take effect. The renderer's key
     *  event path on an empty editable is the same crash family. Swallow
     *  DEL key downs/ups when the shadow is empty. Other keys pass
     *  through unchanged. */
    override fun sendKeyEvent(event: android.view.KeyEvent?): Boolean {
        if (event != null && event.keyCode == android.view.KeyEvent.KEYCODE_DEL && isActiveShadowEmpty()) {
            EditorImeShield.noteEmptyKeyDelete()
            return true
        }
        if (event != null && event.keyCode == android.view.KeyEvent.KEYCODE_DEL) {
            EditorImeShield.noteForwardedKeyDelete()
        }
        return super.sendKeyEvent(event)
    }

    // -------- Empty-editor IME housekeeping: also handled locally. --------
    //
    // FUTO Keyboard's backspace pipeline is not just "read then delete".
    // Depending on prediction/composition state it may wrap the operation
    // in batch edits, clear composition, set selection to 0..0, request
    // cursor updates, or send a private command. On Android 11 / Chromium
    // 147, any of those renderer-facing empty-editable paths can be part
    // of the same crash family. When the shadow is empty, these calls are
    // semantically no-ops, so answer success locally and keep Chromium out
    // of the backspace path entirely.

    override fun beginBatchEdit(): Boolean {
        if (isActiveShadowEmpty()) {
            EditorImeShield.noteEmptyBatch()
            return true
        }
        return super.beginBatchEdit()
    }

    override fun endBatchEdit(): Boolean {
        if (isActiveShadowEmpty()) {
            EditorImeShield.noteEmptyBatch()
            return true
        }
        return super.endBatchEdit()
    }

    override fun finishComposingText(): Boolean {
        if (isActiveShadowEmpty()) {
            EditorImeShield.noteEmptyComposition()
            return true
        }
        return super.finishComposingText()
    }

    override fun setComposingRegion(start: Int, end: Int): Boolean {
        if (isActiveShadowEmpty()) {
            EditorImeShield.noteEmptyComposition()
            return true
        }
        return super.setComposingRegion(start, end)
    }

    override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean {
        if (isActiveShadowEmpty() && text.isNullOrEmpty()) {
            EditorImeShield.noteEmptyComposition()
            return true
        }
        return super.setComposingText(text, newCursorPosition)
    }

    override fun setSelection(start: Int, end: Int): Boolean {
        if (isActiveShadowEmpty()) {
            EditorImeShield.noteEmptySelection()
            return true
        }
        return super.setSelection(start, end)
    }

    override fun performPrivateCommand(action: String?, data: Bundle?): Boolean {
        if (isActiveShadowEmpty()) {
            EditorImeShield.noteEmptyPrivateCommand()
            return true
        }
        return super.performPrivateCommand(action, data)
    }

    override fun requestCursorUpdates(cursorUpdateMode: Int): Boolean {
        if (isActiveShadowEmpty()) {
            EditorImeShield.noteEmptyCursorUpdate()
            return true
        }
        return super.requestCursorUpdates(cursorUpdateMode)
    }

    override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
        if (isActiveShadowEmpty() && text.isNullOrEmpty()) {
            EditorImeShield.noteEmptyComposition()
            return true
        }
        return super.commitText(text, newCursorPosition)
    }

    override fun commitCompletion(text: CompletionInfo?): Boolean {
        if (isActiveShadowEmpty() && text == null) {
            EditorImeShield.noteEmptyComposition()
            return true
        }
        return super.commitCompletion(text)
    }

    override fun commitCorrection(correctionInfo: CorrectionInfo?): Boolean {
        if (isActiveShadowEmpty() && correctionInfo == null) {
            EditorImeShield.noteEmptyComposition()
            return true
        }
        return super.commitCorrection(correctionInfo)
    }

    // -------- Everything else: delegate (renderer does the work). --------
    //
    // InputConnectionWrapper forwards every overridable method to the
    // target by default, so we deliberately do NOT override:
    //   - commitContent
    //   - performEditorAction, performContextMenuAction
    //   - clearMetaKeyStates
    //   - closeConnection
    //   - reportFullscreenMode, getHandler
    //
    // commitText / setComposingText with NON-empty text on an empty doc
    // must NOT be short-circuited — that's how the user types their
    // first character.
}

/** TextUtils import marker — keeps the import alive if a future revision
 *  needs to compare CharSequences here. Cheap, prevents "unused" warning
 *  from churning on this file. */
@Suppress("unused")
private val _keepImports: TextUtils? = null

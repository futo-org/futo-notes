package com.futo.notes.textfirst

import uniffi.futo_notes_ffi.EditorBlockCommand
import uniffi.futo_notes_ffi.EditorParagraphKey
import uniffi.futo_notes_ffi.EditorSessionException

/**
 * What kind of user action the engine refused, so its toast fits. A call the
 * user did not make (a vault refresh, a coordinated change, a reload, a save)
 * passes none and refuses silently.
 */
internal enum class RefusedEdit(val messageKey: String) {
    FORMAT("editor.refused.format"),
    INDENT("editor.refused.indent"),
    TEXT("editor.refused.text"),
    EDIT("editor.refused.edit");

    companion object {
        fun forBlock(command: EditorBlockCommand): RefusedEdit = when (command) {
            EditorBlockCommand.Indent, EditorBlockCommand.Outdent -> INDENT
            else -> FORMAT
        }

        fun forKey(key: EditorParagraphKey): RefusedEdit = when (key) {
            EditorParagraphKey.TAB, EditorParagraphKey.SHIFT_TAB -> INDENT
            else -> EDIT
        }

        /**
         * The toast for a refusal of [action], or null for none. A bad range or
         * text is the shell's own bookkeeping out of step, not the user's
         * mistake, so it never claims to know what was refused.
         */
        fun toastFor(action: RefusedEdit?, error: EditorSessionException): RefusedEdit? = when {
            action == null -> null
            error is EditorSessionException.InvalidRange || error is EditorSessionException.InvalidText -> EDIT
            else -> action
        }
    }
}

/** At most one refusal toast per [intervalMs], so a held key or a burst of refused keystrokes shows one. */
internal class RefusalToastThrottle(private val intervalMs: Long = 2_000L) {
    private var lastShown = Long.MIN_VALUE

    fun admit(nowMs: Long): Boolean {
        if (lastShown != Long.MIN_VALUE && nowMs - lastShown < intervalMs) return false
        lastShown = nowMs
        return true
    }
}

package com.futo.notes.textfirst

import android.text.Selection

/** The two native selection tokens are the bounded exception to suppressing moved spans. */
internal class ChunkedSelectionNotifications(private val text: ChunkedEditable) {
    private val anchor = Selection.getSelectionStart(text)
    private val focus = Selection.getSelectionEnd(text)

    /** Notify after the final text/style watchers, when Layout can read the resulting caret. */
    fun afterReplace(replacementEnd: Int) {
        val watchers = text.spanWatchers.toTypedArray()
        val finalAnchor = Selection.getSelectionStart(text)
        val finalFocus = Selection.getSelectionEnd(text)
        var failure: Throwable? = null
        for (index in 0..1) {
            val token = if (index == 0) Selection.SELECTION_START else Selection.SELECTION_END
            val before = if (index == 0) anchor else focus
            val after = if (index == 0) finalAnchor else finalFocus
            if (before < 0 || after < 0 || before == after) continue
            // SpannableStringBuilder approximates the old coordinate inside
            // its replacement envelope with the final coordinate. Outside
            // that envelope the original point is known exactly.
            val previous = if (after > replacementEnd) before else after
            for (watcher in watchers) try {
                watcher.onSpanChanged(text, token, previous, previous, after, after)
            } catch (error: Throwable) {
                val prior = failure
                if (prior == null) failure = error else if (prior !== error) prior.addSuppressed(error)
            }
        }
        failure?.let { throw it }
    }
}

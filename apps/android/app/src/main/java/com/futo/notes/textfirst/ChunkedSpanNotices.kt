package com.futo.notes.textfirst

import android.text.SpanWatcher

/** A span added, moved or removed, as span watchers are told it. */
internal class SpanNotice(val kind: Int, val what: Any, val oldStart: Int, val oldEnd: Int, val start: Int, val end: Int) {
    companion object { const val ADDED = 0; const val CHANGED = 1; const val REMOVED = 2 }
}

/**
 * Span watchers are told of a span only while the TextView's layout has the text: after the text watchers that bring
 * it there. Told earlier, the TextView placed its cursor handle with the old layout's lines over the new text and
 * threw from Paint.getRunAdvance (crash #1870, Android 11). SpannableStringBuilder likewise tells span watchers only
 * while text and layout agree. Outside a renderer update a notice goes out at once; during one it is held until the
 * update's text watchers have run ([take], [send], [withRendererUpdate]).
 */
internal class ChunkedSpanNotices(private val text: ChunkedEditable) {
    private var held = ArrayList<SpanNotice>()

    /** Tell the span watchers now, or, during a renderer update, once its text watchers have run. */
    fun notice(notice: SpanNotice) {
        if (text.rendererChange != null) { held.add(notice); return }
        for (w in text.spanWatchers.toTypedArray()) tell(w, notice, notice.start, notice.end)
    }

    /** The notices a renderer update held, taken as it ends so an update its watchers start keeps its own. */
    fun take(): List<SpanNotice> {
        if (held.isEmpty()) return emptyList()
        return held.also { held = ArrayList() }
    }

    /**
     * Send [notices] once the text watchers have run. A span still here is reported where it now is, since later
     * edits of the update may have moved it; a gone one where it last was, kept inside the text.
     */
    fun send(notices: List<SpanNotice>) {
        if (notices.isEmpty()) return
        val watchers = text.spanWatchers.toTypedArray()
        var failure: Throwable? = null
        for (n in notices) {
            val here = n.kind != SpanNotice.REMOVED && text.home[n.what] != null
            val start = if (here) text.getSpanStart(n.what) else n.start.coerceIn(0, text.length)
            val end = if (here) text.getSpanEnd(n.what) else n.end.coerceIn(0, text.length)
            for (w in watchers) try {
                tell(w, n, start, end)
            } catch (error: Throwable) {
                val prior = failure
                if (prior == null) failure = error else if (prior !== error) prior.addSuppressed(error)
            }
        }
        failure?.let { throw it }
    }

    private fun tell(w: SpanWatcher, n: SpanNotice, start: Int, end: Int) = when (n.kind) {
        SpanNotice.ADDED -> w.onSpanAdded(text, n.what, start, end)
        SpanNotice.CHANGED -> w.onSpanChanged(text, n.what, n.oldStart.coerceIn(0, text.length), n.oldEnd.coerceIn(0, text.length), start, end)
        else -> w.onSpanRemoved(text, n.what, start, end)
    }
}

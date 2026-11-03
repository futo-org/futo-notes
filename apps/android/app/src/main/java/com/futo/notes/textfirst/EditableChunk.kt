package com.futo.notes.textfirst

import android.text.SpannableStringBuilder

/** One chunk of [ChunkedEditable]: whole lines and the spans that start in them. */
internal class EditableChunk(var text: SpannableStringBuilder) {
    /** Concrete classes of the spans in this chunk, with counts. */
    val kinds = HashMap<Class<*>, Int>()
    fun hasKind(kind: Class<*>): Boolean = kinds.keys.any { kind.isAssignableFrom(it) }
    fun added(span: Any) { kinds.merge(span.javaClass, 1, Int::plus) }
    fun removed(span: Any) {
        val c = span.javaClass
        val n = (kinds[c] ?: return) - 1
        if (n <= 0) kinds.remove(c) else kinds[c] = n
    }
}

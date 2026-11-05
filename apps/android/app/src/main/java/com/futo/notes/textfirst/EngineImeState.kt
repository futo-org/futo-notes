package com.futo.notes.textfirst

/** Small immutable keyboard context, captured only on the editor thread. */
internal data class EngineImeState(
    val selectionStart: Int,
    val selectionEnd: Int,
    val composingStart: Int,
    val composingEnd: Int,
    val capsModes: Int,
    val context: ImeContextWindow?,
) {
    companion object {
        fun capture(text: CharSequence, start: Int, end: Int, composingStart: Int, composingEnd: Int, capsModes: Int): EngineImeState =
            EngineImeState(start, end, composingStart, composingEnd, capsModes,
                ImeContextWindow.capture(text, start, end, before = IME_CONTEXT_CHARS / 2, after = IME_CONTEXT_CHARS / 2))
    }
}

/** Limits apply to keyboard context only. Canonical Copy/Cut still return the complete selection. */
internal const val IME_SELECTED_CHARS = 1_024
internal const val IME_CONTEXT_CHARS = 2_048

internal data class ImeContextWindow(val text: String, val start: Int, val selectionStart: Int, val selectionEnd: Int) {
    companion object {
        fun capture(text: CharSequence, start: Int, end: Int, low: Int = 0, high: Int = text.length,
                    before: Int = IME_CONTEXT_CHARS, after: Int = IME_CONTEXT_CHARS): ImeContextWindow? {
            require(low >= 0 && low <= start && start <= end && end <= high && high <= text.length)
            require(before >= 0 && after >= 0)
            if (end - start > IME_SELECTED_CHARS) return null
            var from = maxOf(low, start - minOf(before, IME_CONTEXT_CHARS))
            var to = end + minOf(high - end, minOf(after, IME_CONTEXT_CHARS))
            // Context is allowed to be shorter than requested, but never half a UTF-16 scalar.
            if (from > low && from < start && Character.isLowSurrogate(text[from]) && Character.isHighSurrogate(text[from - 1])) from++
            if (to < high && to > end && Character.isHighSurrogate(text[to - 1]) && Character.isLowSurrogate(text[to])) to--
            return ImeContextWindow(text.subSequence(from, to).toString(), from - low, start - from, end - from)
        }
    }
}

internal fun imeTextBefore(text: CharSequence, start: Int, low: Int, requested: Int): CharSequence {
    require(requested >= 0)
    var from = maxOf(low, start - minOf(requested, IME_CONTEXT_CHARS))
    if (from > low && from < start && Character.isLowSurrogate(text[from]) && Character.isHighSurrogate(text[from - 1])) from++
    return text.subSequence(from, start).toString()
}

internal fun imeTextAfter(text: CharSequence, end: Int, high: Int, requested: Int): CharSequence {
    require(requested >= 0)
    var to = end + minOf(high - end, minOf(requested, IME_CONTEXT_CHARS))
    if (to < high && to > end && Character.isHighSurrogate(text[to - 1]) && Character.isLowSurrogate(text[to])) to--
    return text.subSequence(end, to).toString()
}

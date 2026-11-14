package com.futo.notes.textfirst

import android.text.SpanWatcher
import android.text.Spanned
import android.text.TextWatcher

/** Match SpannableStringBuilder: DynamicLayout must reflow before TextView
 * scrolls its selection. Registration order exposes obsolete line limits on
 * image insertion and other edits that wrap trailing text onto another line.
 * Sorting happens when a watcher is registered, never on a keystroke. */
internal fun orderWatcherCallbacks(
    text: MutableList<TextWatcher>,
    spans: MutableList<SpanWatcher>,
    flags: Map<Any, Int>,
) {
    text.sortByDescending { flags[it]!! and Spanned.SPAN_PRIORITY }
    spans.sortByDescending { flags[it]!! and Spanned.SPAN_PRIORITY }
}

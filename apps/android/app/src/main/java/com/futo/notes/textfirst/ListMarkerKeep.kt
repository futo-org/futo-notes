package com.futo.notes.textfirst

import android.os.Build
import android.text.Spannable
import android.text.style.LineBreakConfigSpan

// An item's marker unit kept on one row with its text's first character (SpanSpec.ListMarkerKeep). The platform's
// no-break span (API 35) is final, so it is no TfSpan: the renderer sets it and clears it itself.

/** Keep [start, end) of [target] on one row. */
internal fun setListMarkerKeep(target: Spannable, start: Int, end: Int) {
    if (Build.VERSION.SDK_INT < 35) return
    target.setSpan(LineBreakConfigSpan.createNoBreakSpan(), start, end, TF_SPAN_FLAGS)
}

/** Clear the keeps inside [start, end] of [target]: the window's plan sets them again. */
internal fun clearListMarkerKeeps(target: Spannable, start: Int, end: Int) {
    if (Build.VERSION.SDK_INT < 35) return
    for (span in target.getSpans(start, end, LineBreakConfigSpan::class.java)) {
        if (target.getSpanStart(span) >= start && target.getSpanEnd(span) <= end) target.removeSpan(span)
    }
}

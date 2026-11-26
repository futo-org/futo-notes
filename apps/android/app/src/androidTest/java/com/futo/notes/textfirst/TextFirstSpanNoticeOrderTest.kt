package com.futo.notes.textfirst

import android.text.Editable
import android.text.SpanWatcher
import android.text.Spannable
import android.text.Spanned
import android.text.style.UnderlineSpan
import org.junit.Assert.assertEquals
import org.junit.Test

/** Span watchers hear of a span only while the TextView's layout has the text (ChunkedSpanNotices). */
class TextFirstSpanNoticeOrderTest {
    /**
     * Crash report #1870 (v2.0.0, Android 11): an edit emptied an exclusive span (the keyboard's composing underline)
     * and its removal reached the TextView before the layout had the edit, so the TextView placed its cursor handle with
     * the old layout's lines over the new text: IndexOutOfBoundsException in Paint.getRunAdvance. Span watchers are told
     * only while the layout has the text, through an engine update and through a keyboard's direct edit alike.
     */
    @Test fun spanWatchersAreToldOnlyWhileTheLayoutHasTheText() = rendererOnlyView("span-notices") { view ->
        view.apply(UiUpdate(2, "hello world\n", emptyList(), 0, 0, -1, -1, emptyList(), 0L))
        val engine = SpanNoticeLayoutCheck(view)
        val composing = UnderlineSpan()
        view.editableText.setSpan(composing, 6, 11, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE or Spanned.SPAN_COMPOSING)
        // A restyled row sends the edit through replaceKeepingRowSpans, as in the crash.
        view.apply(UiUpdate(3, null, listOf(TextEdit(6, 11, "")), 6, 6, -1, -1, listOf(StyleWindow(0, 7, emptyList())), 0L))
        assertEquals("an engine update: the emptied span was reported removed", listOf<Any>(composing), engine.removed)
        assertEquals("an engine update", emptyList<String>(), engine.stale)

        // The note view takes edits only from the engine; a plain EditText over the same Editable takes them directly.
        val plain = android.widget.EditText(view.context).apply {
            layoutParams = android.view.ViewGroup.LayoutParams(1000, android.view.ViewGroup.LayoutParams.WRAP_CONTENT)
            setEditableFactory(object : Editable.Factory() {
                override fun newEditable(source: CharSequence): Editable = ChunkedEditable.from(source)
            })
            setText("hello world\n", android.widget.TextView.BufferType.EDITABLE)
        }
        val direct = SpanNoticeLayoutCheck(plain)
        val typed = UnderlineSpan()
        plain.editableText.setSpan(typed, 0, 5, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        plain.editableText.replace(0, 5, "")
        assertEquals("a direct edit: the emptied span was reported removed", listOf<Any>(typed), direct.removed)
        assertEquals("a direct edit", emptyList<String>(), direct.stale)
    }

    /** Lays [view] out, then records each span notice its Editable sends while its layout does not have its text. */
    private class SpanNoticeLayoutCheck(private val view: android.widget.TextView) : SpanWatcher {
        val removed = mutableListOf<Any>()
        val stale = mutableListOf<String>()

        init {
            view.measure(android.view.View.MeasureSpec.makeMeasureSpec(1000, android.view.View.MeasureSpec.EXACTLY),
                android.view.View.MeasureSpec.makeMeasureSpec(0, android.view.View.MeasureSpec.UNSPECIFIED))
            view.layout(0, 0, 1000, view.measuredHeight)
            check(view.editableText is ChunkedEditable && view.layout != null)
            view.editableText.setSpan(this, 0, view.length(), Spanned.SPAN_INCLUSIVE_INCLUSIVE)
        }

        private fun check(notice: String) {
            val layout = view.layout
            val laidOut = layout.getLineEnd(layout.lineCount - 1)
            if (laidOut != view.length()) stale += "$notice: ${view.length()} characters, laid out as $laidOut"
        }

        override fun onSpanAdded(text: Spannable, what: Any, start: Int, end: Int) = check("added $what")
        override fun onSpanRemoved(text: Spannable, what: Any, start: Int, end: Int) {
            if (what is UnderlineSpan) removed += what
            check("removed $what")
        }
        override fun onSpanChanged(text: Spannable, what: Any, oldStart: Int, oldEnd: Int, start: Int, end: Int) = check("changed $what")
    }
}

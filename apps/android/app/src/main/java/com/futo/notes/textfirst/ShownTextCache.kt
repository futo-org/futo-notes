package com.futo.notes.textfirst

import android.text.TextPaint
import android.text.TextUtils

/**
 * A header label as drawn, kept while its text, its room and its paint's face and size stay the same: the chrome is
 * drawn every frame (the caret blinks), and measuring and cutting a label each time allocates.
 */
internal class ShownTextCache {
    private class Shown(val room: Float, val chars: Int, val textSize: Float, val face: Any?, val shown: String)

    private val shownByText = HashMap<String, Shown>()

    /** [text] cut at [chars] characters (its last one an ellipsis), then to [room] in [paint]. */
    fun shown(text: String, paint: TextPaint, room: Float, chars: Int = Int.MAX_VALUE): String {
        shownByText[text]?.let { if (it.room == room && it.chars == chars && it.textSize == paint.textSize && it.face === paint.typeface) return it.shown }
        val capped = if (text.length > chars) text.take(chars - 1) + "…" else text
        val shown = TextUtils.ellipsize(capped, paint, room, TextUtils.TruncateAt.END).toString()
        if (shownByText.size > 64) shownByText.clear()
        shownByText[text] = Shown(room, chars, paint.textSize, paint.typeface, shown)
        return shown
    }
}

/** A line number's text, made once per number. */
internal class NumberTexts {
    private val texts = ArrayList<String>()

    fun of(number: Int): String {
        if (number < 0) return number.toString()
        while (texts.size <= number) texts.add(texts.size.toString())
        return texts[number]
    }
}

package com.futo.notes.textfirst

import android.graphics.Canvas
import android.os.Build
import android.text.SpannableStringBuilder
import android.text.StaticLayout
import android.text.TextDirectionHeuristics

/**
 * A photo lifted out of a line of text (`Nice!![](a.jpg)`, #450). Its place cannot close by
 * sliding whole lines: the line it leaves is laid out again without it. So the preview lays out
 * two small paragraphs of its own, with the note's paint, width and spacing and the line's own
 * spans: the line without the photo (what stays in its place), and the photo as a line of its
 * own (the copy in the gap, as it will land). Each ends with a line break and a sentinel line,
 * so its height includes the spacing a line in the middle of the note has. They are laid out
 * again when the width changes or the photo decodes; nothing else in the note is.
 */
internal class PhotoLine private constructor(
    val image: TfImage,
    /** The line, display offsets, its ending left out. */
    val start: Int,
    val end: Int,
    private val imageStart: Int,
    private val imageEnd: Int,
) {
    private var width = -1
    private var bitmaps: List<Pair<Any?, Boolean>>? = null
    private var rest: StaticLayout? = null
    private var alone: StaticLayout? = null

    val restHeight get() = rest?.let { it.getLineTop(it.lineCount - 1).toFloat() } ?: 0f
    val aloneHeight get() = alone?.let { it.getLineTop(it.lineCount - 1).toFloat() } ?: 0f

    /** The photo's text, and its line's without it, as the note holds them now. */
    fun text(e: CharSequence) = e.subSequence(imageStart, imageEnd).toString()
    fun rest(e: CharSequence) = e.subSequence(start, imageStart).toString() + e.subSequence(imageEnd, end)

    /** The slot below the line: the next line's top, or the note's end. */
    fun below(view: TextFirstEditText): BlockSlot {
        val last = view.length() - 1
        return if (end < last) BlockSlot(end + 1, false) else BlockSlot(last, true)
    }

    /** Lay both out again if the width or any photo of the line (the lifted one or a sibling) changed since. */
    fun measure(view: TextFirstEditText) {
        val l = view.layout ?: return
        val e = view.editableText ?: return
        val photos = e.getSpans(start, end, TfImage::class.java).map { it.bitmap to it.failed }
        if (l.width == width && photos == bitmaps && rest != null) return
        width = l.width
        bitmaps = photos
        val without = SpannableStringBuilder(e, start, end).apply { delete(imageStart - start, imageEnd - start) }
        rest = lay(view, without)
        // The photo as it lands at a plain slot: without its line's marker, box, indent or quote bar.
        val photo = SpannableStringBuilder(e, imageStart, imageEnd).apply {
            for (span in getSpans(0, length, android.text.style.ParagraphStyle::class.java)) removeSpan(span)
        }
        alone = lay(view, photo)
    }

    /** Lay both out again at the next measure (the view re-laid out: a photo may have decoded). */
    fun invalidate() { rest = null }

    private fun lay(view: TextFirstEditText, text: SpannableStringBuilder): StaticLayout {
        text.append("\n").append(TextFirstEditText.END_SENTINEL)
        val direction = if (Build.VERSION.SDK_INT >= 29) view.textDirectionHeuristic else TextDirectionHeuristics.FIRSTSTRONG_LTR
        return StaticLayout.Builder.obtain(text, 0, text.length, view.paint, maxOf(1, width))
            .setAlignment(view.layout?.alignment ?: android.text.Layout.Alignment.ALIGN_NORMAL)
            .setLineSpacing(view.lineSpacingExtra, view.lineSpacingMultiplier)
            .setIncludePad(view.includeFontPadding)
            .setUseLineSpacingFromFallbacks(view.isFallbackLineSpacing)
            .setBreakStrategy(view.breakStrategy)
            .setHyphenationFrequency(view.hyphenationFrequency)
            .setJustificationMode(view.justificationMode)
            .setTextDirection(direction)
            .build()
    }

    fun drawRest(canvas: Canvas, view: TextFirstEditText, top: Float) = draw(canvas, view, rest, top, restHeight)
    fun drawAlone(canvas: Canvas, view: TextFirstEditText, top: Float) = draw(canvas, view, alone, top, aloneHeight)

    private fun draw(canvas: Canvas, view: TextFirstEditText, layout: StaticLayout?, top: Float, height: Float) {
        layout ?: return
        val save = canvas.save()
        canvas.translate(view.totalPaddingLeft.toFloat(), top)
        canvas.clipRect(-view.totalPaddingLeft.toFloat(), 0f, view.width.toFloat(), height)
        view.paint.color = view.currentTextColor
        layout.draw(canvas)
        canvas.restoreToCount(save)
    }

    companion object {
        fun of(view: TextFirstEditText, image: TfImage): PhotoLine? {
            val e = view.editableText ?: return null
            val s = e.getSpanStart(image)
            val en = e.getSpanEnd(image)
            if (s < 0 || en < s) return null
            val last = view.length() - 1
            val start = e.lastIndexOf('\n', s - 1) + 1
            val end = e.indexOf('\n', en).let { if (it < 0 || it > last) last else it }
            return PhotoLine(image, start, end, s, en).also { it.measure(view) }
        }
    }
}

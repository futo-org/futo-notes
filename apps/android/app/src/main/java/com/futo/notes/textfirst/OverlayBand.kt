package com.futo.notes.textfirst

import android.graphics.Matrix
import android.graphics.Path
import android.graphics.RectF
import android.text.Layout
import android.text.Spanned
import android.text.TextPaint
import android.text.style.MetricAffectingSpan

/**
 * Where everything laid over row [line]'s text is drawn: a selection, a find mark, the current match, a selected list
 * marker, a selected line break. As tall as the row's text box (what the platform's selection takes), centred on the
 * row's letters as seen (capital tops to descender bottoms), inside the row: the text box itself reaches far above the
 * capitals and barely below the descenders, so overlays on it sat high on the letters. Layout coordinates.
 */
internal fun TextFirstEditText.overlayBand(l: Layout, e: Spanned, line: Int): Pair<Float, Float> {
    val (rowTop, rowBottom) = textRowBand(l, e, line)
    val baseline = l.getLineBaseline(line)
    // The layout counts the line spacing into every row's descent but the last's.
    val spacing = if (line + 1 < l.lineCount) l.spacingAdd else 0f
    val height = minOf(rowBottom - rowTop, baseline + l.getLineDescent(line) - spacing - rowTop)
    val band = codeChrome.overlayBand
    val at = l.getLineStart(line)
    band.paint.set(paint)
    for (span in e.getSpans(at, minOf(e.length, at + 1), MetricAffectingSpan::class.java)) span.updateMeasureState(band.paint)
    val (seenTop, seenBottom) = visibleLineSpan(band.paint)
    val centre = baseline + (seenTop + seenBottom) / 2f
    val top = (centre - height / 2f).coerceIn(rowTop, rowBottom - height)
    return top to top + height
}

/** [path], drawn on row [line]'s text box, moved and fitted to its [overlayBand]. */
internal fun TextFirstEditText.fitToOverlayBand(l: Layout, e: Spanned, line: Int, path: Path) {
    val (top, bottom) = overlayBand(l, e, line)
    val band = codeChrome.overlayBand
    path.computeBounds(band.from, true)
    if (band.from.isEmpty) return
    band.to.set(band.from.left, top, band.from.right, bottom)
    band.matrix.setRectToRect(band.from, band.to, Matrix.ScaleToFit.FILL)
    path.transform(band.matrix)
}

/** The scratch objects [overlayBand] works with, kept by the view (CodeBlockChrome). */
internal class OverlayBandScratch {
    val paint = TextPaint()
    val from = RectF()
    val to = RectF()
    val matrix = Matrix()
}


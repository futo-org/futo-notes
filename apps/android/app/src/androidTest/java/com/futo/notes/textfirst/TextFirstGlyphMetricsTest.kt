package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.text.TextPaint
import android.text.style.MetricAffectingSpan
import androidx.core.content.res.ResourcesCompat
import androidx.test.platform.app.InstrumentationRegistry
import com.futo.notes.R
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

/** How far styled glyphs reach past the advance the caret is placed at. */
class TextFirstGlyphMetricsTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val look: TextFirstStyle = run {
        val metrics = context.resources.displayMetrics
        TextFirstStyle(
            metrics.density, 17f * metrics.scaledDensity,
            ResourcesCompat.getFont(context, R.font.barlow_regular)!!,
            ResourcesCompat.getFont(context, R.font.barlow_semibold)!!,
            ResourcesCompat.getFont(context, R.font.barlow_bold)!!,
            ResourcesCompat.getFont(context, R.font.jetbrains_mono_regular)!!,
            Color.BLACK, Color.GRAY, Color.BLUE, Color.GRAY, Color.WHITE, Color.WHITE,
            italic = ResourcesCompat.getFont(context, R.font.barlow_italic)!!,
            boldItalic = ResourcesCompat.getFont(context, R.font.barlow_bold_italic)!!,
            semiboldItalic = ResourcesCompat.getFont(context, R.font.barlow_semibold_italic)!!,
            medium = ResourcesCompat.getFont(context, R.font.barlow_medium)!!,
            mediumItalic = ResourcesCompat.getFont(context, R.font.barlow_medium_italic)!!,
            extraBold = ResourcesCompat.getFont(context, R.font.barlow_extrabold)!!,
            extraBoldItalic = ResourcesCompat.getFont(context, R.font.barlow_extrabold_italic)!!,
        )
    }

    private fun layOut(view: TextFirstEditText, width: Int, height: Int) {
        view.layoutParams = android.view.ViewGroup.LayoutParams(width, height)
        val exact = android.view.View.MeasureSpec.EXACTLY
        view.measure(android.view.View.MeasureSpec.makeMeasureSpec(width, exact), android.view.View.MeasureSpec.makeMeasureSpec(height, exact))
        view.layout(0, 0, width, height)
    }

    private class GlyphInk(val advance: Float, val width: Int, val height: Int, val pixels: IntArray, val overhang: Float)

    /** The reference sets its bundled face directly, independently of the renderer span. */
    private fun ink(bold: Boolean, italic: Boolean, text: String = "wmvl", reference: Typeface? = null, fakeBold: Boolean = false): GlyphInk {
        val base = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
            textSize = look.textSizePx
            typeface = reference ?: look.regular
            color = Color.BLACK
            isFakeBoldText = fakeBold
        }
        // As the platform does, measuring and drawing each style their own copy of the run's paint.
        val measure = TextPaint(base)
        val paint = TextPaint(base)
        if (reference == null) {
            TfInline(look, bold, italic, strike = false, code = false).updateMeasureState(measure)
            TfInline(look, bold, italic, strike = false, code = false).updateDrawState(paint)
        }
        val advance = measure.measureText(text)
        val bitmap = Bitmap.createBitmap((advance + look.textSizePx * 2).toInt(), (look.textSizePx * 2).toInt(), Bitmap.Config.ARGB_8888)
        try {
            bitmap.eraseColor(Color.WHITE)
            val canvas = Canvas(bitmap)
            canvas.drawText(text, look.textSizePx / 2, look.textSizePx * 1.4f, paint)
            val pixels = IntArray(bitmap.width * bitmap.height)
            bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
            var right = -1
            for (x in bitmap.width - 1 downTo 0) {
                if ((0 until bitmap.height).any { Color.red(pixels[it * bitmap.width + x]) < 128 }) { right = x; break }
            }
            val overhang = (right + 1 - look.textSizePx / 2 - advance) / look.textSizePx
            return GlyphInk(advance, bitmap.width, bitmap.height, pixels, overhang)
        } finally { bitmap.recycle() }
    }

    /** Ink to the right of the text's advance, as a fraction of the font size. */
    private fun overhang(bold: Boolean, italic: Boolean): Float = ink(bold, italic).overhang

    /**
     * Italic is the bundled Barlow Italic, never the platform's synthetic slant
     * (skew 0.25, about 0.18em past an upright run) and never a skew of our own
     * on top of it (0.29em): its ink stays near the advance the caret sits at.
     */
    @Test fun italicSlantsOnceNotTwice() {
        val upright = overhang(bold = false, italic = false)
        assertTrue("italic reaches ${overhang(false, true) - upright}em past upright", overhang(false, true) - upright < 0.25f)
        assertTrue("bold italic reaches ${overhang(true, true) - overhang(true, false)}em past bold", overhang(true, true) - overhang(true, false) < 0.25f)
    }

    /** Bold's advance and ink match the bundled face without synthetic emboldening. */
    @Test fun boldInkEndsAtItsAdvance() {
        val reference = ink(bold = true, italic = false, reference = look.bold)
        fun matches(actual: GlyphInk) {
            assertEquals("bundled bold advance", reference.advance, actual.advance, 0f)
            assertEquals(reference.width, actual.width)
            assertEquals(reference.height, actual.height)
            assertArrayEquals("bundled bold ink at the same raster phase", reference.pixels, actual.pixels)
        }
        matches(ink(bold = true, italic = false))
        assertThrows(AssertionError::class.java) {
            matches(ink(bold = true, italic = false, reference = look.bold, fakeBold = true))
        }
    }

    /** Changing the level replaces the heading span after the retained inline spans. */
    @Test fun headingEmphasisSurvivesChangingHeadingLevel() = runBlocking(Dispatchers.Main) {
        val images = ImageLoader(context, context.cacheDir)
        try {
            val view = TextFirstEditText(context, look, images)
            val text = ChunkedEditable.from("a b c" + TextFirstEditText.END_SENTINEL)
            val inline = listOf(
                SpanSpec.Inline(0, 1, bold = true, italic = false, strike = false, code = false),
                SpanSpec.Inline(2, 3, bold = false, italic = true, strike = false, code = false),
                SpanSpec.Inline(4, 5, bold = false, italic = false, strike = true, code = false),
            )
            view.addSpans(text, listOf(SpanSpec.Heading(0, 5, 1)) + inline)
            view.restyle(text, StyleWindow(0, 5, listOf(SpanSpec.Heading(0, 5, 2)) + inline))
            fun paintAt(at: Int) = TextPaint().apply {
                textSize = look.textSizePx
                typeface = look.regular
                for (span in text.getSpans(at, at + 1, MetricAffectingSpan::class.java)) span.updateDrawState(this)
            }
            val bold = paintAt(0)
            assertEquals("bold on a 700 heading is 800", 800, bold.typeface.weight)
            val italic = paintAt(2)
            assertTrue("heading italic is still italic", italic.typeface.isItalic)
            assertEquals("heading italic keeps the heading's weight", 700, italic.typeface.weight)
            assertTrue("heading strike survives its base style", paintAt(4).isStrikeThruText)
            assertEquals(look.textSizePx * 1.375f, bold.textSize, 0.01f)
            assertEquals(look.textSizePx * 1.375f, italic.textSize, 0.01f)
            view.restyle(text, StyleWindow(0, 5, listOf(SpanSpec.Heading(0, 5, 5)) + inline))
            assertEquals("bold on a 500 heading is 700", 700, paintAt(0).typeface.weight)
            assertEquals("italic on a 500 heading keeps 500", 500, paintAt(2).typeface.weight)
            assertTrue(paintAt(2).typeface.isItalic)
            assertEquals(look.textSizePx * 1.125f, paintAt(0).textSize, 0.01f)
            assertEquals("inline markers stay hidden in the display", "a b c" + TextFirstEditText.END_SENTINEL, text.toString())
        } finally {
            images.shutdown()
        }
    }

    /** A real TextView clips its Layout to the content padding; direct span drawing does not. */
    @Test fun orderedMarkerInkSurvivesTheNativeViewClip() = runBlocking(Dispatchers.Main) {
        val images = ImageLoader(context, context.cacheDir)
        try {
            for (depth in listOf(0, 1, 4, 7, 14, 20)) for (rtl in listOf(false, true)) for (number in listOf(9L, 10L, 99L, 100L, 999999999L)) {
                val view = TextFirstEditText(context, look, images)
                view.apply(UiUpdate(1, if (rtl) "\uFFFCאבג\n" else "\uFFFCBox\n", emptyList(), 0, 0, -1, -1,
                    listOf(StyleWindow(0, 5, listOf(
                        SpanSpec.ListRow(0, 5, depth, ListMarker.Ordered, "$number.", false, true),
                        SpanSpec.ListItemMarker(0, 1, depth, ListMarker.Ordered, "$number.", false),
                    ))), 0L))
                val width = look.dp(360f).toInt()
                val height = look.dp(160f).toInt()
                layOut(view, width, height)
                val actual = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                val fullMarker = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                try {
                    actual.eraseColor(Color.WHITE)
                    fullMarker.eraseColor(Color.WHITE)
                    view.draw(Canvas(actual))
                    val text = view.editableText
                    val marker = text.getSpans(0, 1, TfList::class.java).single()
                    val top = view.totalPaddingTop + view.layout.getLineTop(0)
                    val baseline = view.totalPaddingTop + view.layout.getLineBaseline(0)
                    val bottom = view.totalPaddingTop + view.layout.getLineBottom(0)
                    // Same glyph and native font phase, on an unclipped canvas. The
                    // view must retain all marker ink, including its first digit.
                    val dir = view.layout.getParagraphDirection(0)
                    assertEquals(if (rtl) -1 else 1, dir)
                    val edge = view.totalPaddingLeft + if (rtl) view.layout.width else 0
                    marker.drawLeadingMargin(Canvas(fullMarker), TextPaint(), edge, dir, top, baseline, bottom, text, 0, 5, true, view.layout)
                    val margin = 0 until width
                    var ink = 0
                    for (y in top until bottom) for (x in margin) {
                        if (fullMarker.getPixel(x, y) == Color.GRAY) {
                            ink++
                            assertEquals("$number. depth$depth rtl$rtl: native View clipped marker ink at $x,$y", Color.GRAY, actual.getPixel(x, y))
                        }
                    }
                    assertTrue("the reference contains the ordered marker", ink > 0)
                } finally {
                    actual.recycle()
                    fullMarker.recycle()
                }
            }
        } finally { images.shutdown() }
    }


    @Test fun numberMetadataAloneReflowsItsHangingContinuation() = runBlocking(Dispatchers.Main) {
        val images = ImageLoader(context, context.cacheDir)
        try {
            val view = TextFirstEditText(context, look, images)
            val body = "\uFFFC" + "Parcel ".repeat(10) + "\n"
            fun windows(number: Long) = listOf(StyleWindow(0, body.length, listOf(
                SpanSpec.ListRow(0, body.length, 0, ListMarker.Ordered, "$number.", false, true),
                SpanSpec.ListItemMarker(0, 1, 0, ListMarker.Ordered, "$number.", false),
            )))
            view.apply(UiUpdate(1, body, emptyList(), 0, 0, -1, -1, windows(9), 0L))
            val width = view.totalPaddingLeft + view.totalPaddingRight + kotlin.math.ceil(look.listIndent + view.paint.measureText("Parcel Parcel")).toInt() + 1
            val height = look.dp(500f).toInt()
            layOut(view, width, height)
            // The item's text starts after its marker unit.
            val narrowX = view.layout.getPrimaryHorizontal(1)
            val narrowEnd = view.layout.getLineEnd(0)
            view.apply(UiUpdate(2, null, emptyList(), 0, 0, -1, -1, windows(100), 0L))
            assertTrue("a wider number reserves its complete glyphs", view.layout.getPrimaryHorizontal(1) > narrowX)
            assertTrue("metadata-only width changes reflow the existing Layout", view.layout.getLineEnd(0) < narrowEnd)
            assertEquals("the wrapped body hangs at the same text column", view.layout.getPrimaryHorizontal(1), view.layout.getPrimaryHorizontal(view.layout.getLineStart(1)), 0f)
            view.apply(UiUpdate(3, null, emptyList(), 0, 0, -1, -1, windows(9), 0L))
            assertEquals(narrowX, view.layout.getPrimaryHorizontal(1), 0f)
            assertEquals(narrowEnd, view.layout.getLineEnd(0))
            assertEquals(body.replace('\uFFFC', '\u00A0') + TextFirstEditText.END_SENTINEL, view.text.toString())
        } finally { images.shutdown() }
    }


    @Test fun deepListIndentStopsConsumingThePhoneColumn() = runBlocking(Dispatchers.Main) {
        val images = ImageLoader(context, context.cacheDir)
        try {
            for (kind in listOf(ListMarker.Bullet, ListMarker.Ordered, ListMarker.Task)) for (depth in listOf(0, 3, 4, 7, 8, 14, 20)) for (rtl in listOf(false, true)) {
                val line = if (rtl) "אריזה למשלוח\n" else "Parcel ready\n"
                val first = "\uFFFC" + line
                val body = first + line
                val view = TextFirstEditText(context, look, images)
                view.apply(UiUpdate(1, body, emptyList(), 0, 0, -1, -1,
                    listOf(StyleWindow(0, body.length, listOf(
                        SpanSpec.ListRow(0, first.length, depth, kind, "1.", false, true),
                        SpanSpec.ListItemMarker(0, 1, depth, kind, "1.", false),
                        SpanSpec.ListRow(first.length, body.length, depth, kind, "1.", false, false),
                    ))), 0L))
                val width = look.dp(360f).toInt()
                val height = look.dp(120f).toInt()
                layOut(view, width, height)
                val levels = depth + 1
                val normal = minOf(levels, 4)
                val compact = (levels - 4).coerceIn(0, 4)
                val expected = (look.textSizePx * (normal * 1.4f + compact * 0.7f)).toInt()
                // The body starts after the marker unit.
                val at = view.layout.getPrimaryHorizontal(1)
                val indent = if (rtl) view.layout.width - at else at
                assertEquals("$kind depth$depth rtl$rtl: bounded native body indent", expected.toFloat(), indent, 0f)
                assertEquals("$kind depth$depth: a short phrase still fits", first.length, view.layout.getLineEnd(0))
                assertEquals("physical continuation hangs at the same body column", at, view.layout.getPrimaryHorizontal(first.length), 0f)
                // Inside the band the selection is drawn on (overlayBand).
                val y = view.totalPaddingTop + view.overlayBand(view.layout, view.editableText, 0).first.toInt() + 2
                val lead = look.textSizePx * (normal * 1.4f + compact * 0.7f) - look.listIndent
                val x = if (rtl) width - view.totalPaddingRight - lead.toInt() - 2 else view.totalPaddingLeft + lead.toInt() + 2
                val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                try {
                    android.text.Selection.setSelection(view.editableText, 0, first.length)
                    bitmap.eraseColor(Color.WHITE)
                    view.draw(Canvas(bitmap))
                    assertEquals("full row selection includes the bounded marker", androidx.core.graphics.ColorUtils.compositeColors(look.selectionColor, Color.WHITE), bitmap.getPixel(x, y))
                    android.text.Selection.setSelection(view.editableText, 1)
                    bitmap.eraseColor(Color.WHITE)
                    view.draw(Canvas(bitmap))
                    assertEquals("collapsed caret clears that marker", Color.WHITE, bitmap.getPixel(x, y))
                } finally { bitmap.recycle() }
                if (kind == ListMarker.Task) {
                    val dir = if (rtl) -1 else 1
                    val edge = view.totalPaddingLeft + at
                    val center = edge - dir * (look.dp(6f) + look.textSizePx * 0.95f / 2)
                    val middleY = view.totalPaddingTop + (view.layout.getLineTop(0) + view.layout.getLineBottom(0)) / 2f
                    assertEquals("the bounded checkbox still hits its task", 0, checkboxAt(view, look, center, middleY))
                    assertEquals("the first text pixel remains a caret tap", -1, checkboxAt(view, look, edge + dir, middleY))
                }
                assertEquals(body.replace('\uFFFC', '\u00A0') + TextFirstEditText.END_SENTINEL, view.text.toString())
            }
        } finally { images.shutdown() }
    }

    /** An empty or digits-only item has no strong letter: its marker follows the view's own direction, as its layout does. */
    @Test fun anEmptyItemsNumberSitsOnTheTextSideInARightToLeftView() = runBlocking(Dispatchers.Main) {
        val images = ImageLoader(context, context.cacheDir)
        try {
            for (body in listOf("\uFFFC\n", "\uFFFC2025\n")) {
                val view = TextFirstEditText(context, look, images)
                view.textDirection = android.view.View.TEXT_DIRECTION_FIRST_STRONG_RTL
                view.apply(UiUpdate(1, body, emptyList(), 0, 0, -1, -1, listOf(StyleWindow(0, body.length, listOf(
                    SpanSpec.ListRow(0, body.length, 0, ListMarker.Ordered, "100.", false, true),
                    SpanSpec.ListItemMarker(0, 1, 0, ListMarker.Ordered, "100.", false),
                ))), 0L))
                val width = look.dp(360f).toInt()
                val height = look.dp(120f).toInt()
                layOut(view, width, height)
                assertEquals(-1, view.layout.getParagraphDirection(0))
                val marker = view.editableText.getSpans(0, 1, TfListMarker::class.java).single()
                val left = view.totalPaddingLeft + minOf(view.layout.getPrimaryHorizontal(0), view.layout.getPrimaryHorizontal(1)).toInt()
                val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                try {
                    bitmap.eraseColor(Color.WHITE)
                    view.draw(Canvas(bitmap))
                    val top = view.totalPaddingTop + view.layout.getLineTop(0)
                    val bottom = view.totalPaddingTop + view.layout.getLineBottom(0)
                    val inked = (left until left + marker.width).filter { x -> (top until bottom).any { y -> bitmap.getPixel(x, y) != Color.WHITE } }
                    assertTrue("${body.trim()}: the number is drawn", inked.isNotEmpty())
                    // The text is on the column's left: the number starts at the gap beside it.
                    assertEquals("${body.trim()}: the number's first ink", left + look.dp(LIST_NUMBER_GAP_DP), inked.first().toFloat(), look.dp(2f))
                } finally { bitmap.recycle() }
            }
        } finally { images.shutdown() }
    }
}

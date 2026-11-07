package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
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
        )
    }

    /** Ink to the right of the text's advance, as a fraction of the font size. */
    private fun overhang(bold: Boolean, italic: Boolean, text: String = "wmvl"): Float {
        val paint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
            textSize = look.textSizePx
            typeface = look.regular
            color = Color.BLACK
        }
        TfInline(look, bold, italic, strike = false, code = false).updateMeasureState(paint)
        val advance = paint.measureText(text)
        val bitmap = Bitmap.createBitmap((advance + look.textSizePx * 2).toInt(), (look.textSizePx * 2).toInt(), Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(Color.WHITE)
        val canvas = Canvas(bitmap)
        TfInline(look, bold, italic, strike = false, code = false).updateDrawState(paint)
        canvas.drawText(text, look.textSizePx / 2, look.textSizePx * 1.4f, paint)
        var right = -1
        for (x in bitmap.width - 1 downTo 0) {
            if ((0 until bitmap.height).any { Color.red(bitmap.getPixel(x, it)) < 128 }) { right = x; break }
        }
        val overhang = (right + 1 - look.textSizePx / 2 - advance) / look.textSizePx
        return overhang
    }

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

    /** Bold is a real Barlow Bold, never emboldened on top: its ink ends where its advance does. */
    @Test fun boldInkEndsAtItsAdvance() {
        assertEquals(overhang(bold = false, italic = false), overhang(bold = true, italic = false), 0.02f)
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
            assertEquals("heading bold is heavier than its base", 700, bold.typeface.weight)
            val italic = paintAt(2)
            assertTrue("heading italic is still italic", italic.typeface.isItalic)
            assertEquals("heading italic keeps the heading's weight", 600, italic.typeface.weight)
            assertTrue("heading strike survives its base style", paintAt(4).isStrikeThruText)
            assertEquals(look.textSizePx * 1.4f, bold.textSize, 0.01f)
            assertEquals(look.textSizePx * 1.4f, italic.textSize, 0.01f)
            assertEquals("inline markers stay hidden in the display", "a b c" + TextFirstEditText.END_SENTINEL, text.toString())
        } finally {
            images.shutdown()
        }
    }

    @Test fun selectedListMarginFollowsTheMarkerIndentAndDirection() {
        val body = "alpha beta gamma"
        for (kind in listOf(ListMarker.Ordered, ListMarker.Bullet, ListMarker.Task)) for (depth in 0..1) for (dir in listOf(1, -1)) {
            val text = ChunkedEditable.from(body + "\n" + TextFirstEditText.END_SENTINEL)
            val marker = TfList(look, depth = depth, marker = kind, number = 12L, checked = false, first = true)
            text.setSpan(marker, 0, body.length + 1, TF_SPAN_FLAGS)
            val bitmap = Bitmap.createBitmap((look.listIndent * 3).toInt(), (look.textSizePx * 1.55f).toInt(), Bitmap.Config.ARGB_8888)
            bitmap.eraseColor(Color.WHITE)
            try {
                val edge = if (dir > 0) 0 else bitmap.width
                val canvas = Canvas(bitmap)
                marker.drawSelectedMargin(canvas, edge, dir, 0f, bitmap.height.toFloat())
                marker.drawLeadingMargin(canvas, TextPaint(), edge, dir, 0, look.textSizePx.toInt(), bitmap.height, text, 0, body.length + 1, true, null)
                val x = edge + dir * ((look.listIndent * depth).toInt() + 1)
                assertNotEquals("$kind depth$depth dir$dir: the margin includes its marker", Color.WHITE, bitmap.getPixel(x, 1))
                val outside = edge + dir * ((look.listIndent * (depth + 1)).toInt() + 3)
                assertEquals("the body is left to the native selection path", Color.WHITE, bitmap.getPixel(outside, 1))
            } finally { bitmap.recycle() }
        }
    }
}

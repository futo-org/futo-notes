package com.futo.notes.textfirst

import android.graphics.Canvas
import android.os.SystemClock
import android.util.Log

// The reflow preview's landing (#450). At the release the card goes, the copy turns solid and the
// move is committed at once, under the preview. When the moved note arrives the preview is drawn
// from it: every part on screen is found again by paragraph (a move writes whole lines,
// block-movement.md), starts where the preview drew it, and slides the few pixels to where it
// is laid out now, so what the move changes on arrival (a box, an indent, a number) slides in
// with it. Then the preview ends, the note drawn as it is. The view does not scroll.

/**
 * A paragraph the preview showed at the release: display offsets [start] to [end] of the note
 * then, drawn with its top at content y [drawnTop] at a time (it may still be sliding while the
 * engine works). [lands] is where the move puts it, counted from the first paragraph the move
 * rewrites (-1: before that, unchanged). [probe] is its text, to recognise it again.
 */
internal class LandingPiece(val start: Int, val end: Int, val drawnTop: (Long) -> Float, val lands: Int, val solid: Boolean, val probe: String) {
    fun landing(at: Int) = LandingPiece(start, end, drawnTop, at, solid, probe)
}

/** The release, as needed to find each part again in the moved note. */
internal class ReflowCapture(private val tiles: SliceTiles, private val stretch: Int, private val pieces: List<LandingPiece>, private val scrollY: Int, private val at: Long) {
    /** The landing in the note as it is now (the move applied), or null when its parts cannot be found again: then it ends at once. */
    fun land(view: TextFirstEditText, done: () -> Unit): ReflowLanding? {
        val e = view.editableText ?: return null
        val last = view.length() - 1
        val now = SystemClock.uptimeMillis()
        val ms = minOf(Slide.SLIDE_MS, LANDING_CAP_MS - (now - at))
        if (ms <= 0) return null
        val need = (pieces.maxOfOrNull { it.lands } ?: -1) + 1
        // Where each paragraph of the rewritten stretch starts now (an empty last line starts at the end).
        val starts = ArrayList<Int>().apply { add(stretch) }
        var i = stretch
        while (starts.size <= need && i < last) { if (e[i] == '\n') starts += i + 1; i++ }
        if (starts.size < need) return fail("the moved note has fewer lines than the preview showed")
        val elements = ArrayList<LandingElement>()
        for (p in pieces) {
            val from = if (p.lands < 0) p.start else starts[p.lands]
            val to = if (p.lands < 0) p.end else starts.getOrElse(p.lands + 1) { last }
            if (probe(e, from, last) != p.probe) return fail("a paragraph is not where the move should have put it")
            val top = view.boundaryY(BlockSlot(from, false)) ?: return fail("no layout at $from")
            val bottom = view.boundaryY(if (endsAtNoteEnd(e, from, to, last)) BlockSlot(last, true) else BlockSlot(minOf(to, last), false)) ?: return fail("no layout at $to")
            // From where the preview draws it this frame, to where it is laid out now.
            val shift = (p.drawnTop(now) - scrollY) - (top - view.scrollY)
            elements += LandingElement(from, top, bottom, shift, p.solid)
        }
        elements.sortBy { it.top }
        if (elements.zipWithNext().any { (a, b) -> b.top < a.bottom }) return fail("the parts overlap in the moved note")
        return ReflowLanding(view, tiles, elements, now, ms, done)
    }

    private fun fail(why: String): ReflowLanding? {
        Log.w(TAG, "block drag landing drawn without its slide: $why")
        return null
    }

    companion object {
        const val TAG = "BlockReflow"
        /** The landing ends at most this long after the release. */
        const val LANDING_CAP_MS = 400L

        /** A paragraph's start, as read to recognise it: list numbers, markers and leading space left out (a move may rewrite them). */
        fun probe(text: CharSequence, at: Int, last: Int): String {
            var i = at
            val end = minOf(last, at + 200)
            while (i < end && text[i] != '\n' && (text[i].isWhitespace() || text[i].isDigit() || text[i] in "-*+[]xX>#.)")) i++
            val out = StringBuilder()
            while (i < end && text[i] != '\n' && out.length < 24) out.append(text[i++])
            return out.toString()
        }
    }
}

/** One part of the moved note on screen: laid out from [top] to [bottom], first drawn [shift] lower. */
internal class LandingElement(val start: Int, val top: Float, val bottom: Float, val shift: Float, val solid: Boolean)

internal class ReflowLanding(
    private val view: TextFirstEditText,
    private val tiles: SliceTiles,
    private val elements: List<LandingElement>,
    private val start: Long,
    private val ms: Long,
    private val done: () -> Unit,
) {
    private var ended = false
    private val end = Runnable { finish() }
    private val layout = view.layout
    private val width = view.width
    // A bitmap can change row measurements in the existing DynamicLayout.
    private val height = layout?.height

    init { view.postDelayed(end, ms + 100) }

    private fun finish() {
        if (ended) return
        ended = true
        view.removeCallbacks(end)
        done()
    }

    /** Draw the moved note with each part sliding home; false once they are all home (the view draws itself again). */
    fun draw(canvas: Canvas): Boolean {
        val now = SystemClock.uptimeMillis()
        if (ended || now - start >= ms || view.layout !== layout || view.width != width || layout?.height != height) {
            view.post { finish() }
            return false
        }
        val top = view.scrollY.toFloat()
        val bottom = top + view.height
        // What no part covers is where it is; then each part where it slides, a solid one over the page.
        var y = top
        for (el in elements) {
            if (el.top > y) tiles.draw(canvas, y, el.top, 0f, top, bottom)
            y = maxOf(y, el.bottom)
        }
        if (y < bottom) tiles.draw(canvas, y, bottom, 0f, top, bottom)
        for (el in elements.sortedBy { it.solid }) {
            val s = Slide(el.shift, 0f, start, ms).at(now)
            if (el.solid) view.coverSlice(canvas, el.top + s, el.bottom + s, top, bottom)
            tiles.draw(canvas, el.top, el.bottom, s, top, bottom)
        }
        view.drawScrollEdge(canvas)
        view.postInvalidateOnAnimation()
        return true
    }

    /** Where the moved block is drawn now (content y), as solid parts sliding home; null once home. */
    fun movedBlock(): android.graphics.RectF? {
        val now = SystemClock.uptimeMillis()
        val solid = elements.filter { it.solid }
        if (solid.isEmpty() || ended || now - start >= ms) return null
        val s = Slide(solid.first().shift, 0f, start, ms).at(now)
        return android.graphics.RectF(0f, solid.first().top + s, view.width.toFloat(), solid.last().bottom + s)
    }

    /** End now (an interruption, another change to the note). */
    fun cancel() { ended = true; view.removeCallbacks(end) }
}

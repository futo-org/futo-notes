package com.futo.notes.textfirst

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.os.SystemClock
import android.view.animation.PathInterpolator
import java.util.TreeMap
import kotlin.math.abs

// The live reflow preview of a block drag (#450; the behaviour is the reflow spec, #445). While a
// block is lifted the note is drawn as it would be after the drop: the block's place closes, a
// gap opens at the slot the finger chose with a dimmed copy of the block in it, and the content
// between slides. Nothing is edited until the drop. Each slice is the note's own layout drawn
// at its previewed place (BlockDragGeometry.kt `drawNoteRegion`), never a captured image, so
// content that scrolls in under the preview is drawn too; slices are kept by the slot they start
// at, never by screen position. The gap rule and the shifts are BlockReflow.kt. UI thread.

/** A part of the preview sliding from [from] to [to] px over [ms], started at [start] (uptime ms). */
internal class Slide(val from: Float, val to: Float, val start: Long, private val ms: Long = SLIDE_MS) {
    fun at(now: Long): Float {
        val t = (now - start).toFloat() / ms
        return if (t >= 1f || from == to) to else from + (to - from) * EASE.getInterpolation(t.coerceAtLeast(0f))
    }
    fun moving(now: Long) = from != to && now - start < ms
    fun toward(target: Float, now: Long) = if (target == to) this else Slide(at(now), target, now)

    companion object {
        /** Neighbours slide over 180 ms with the web editor's easing. */
        const val SLIDE_MS = 180L
        private val EASE = PathInterpolator(0.2f, 0.9f, 0.3f, 1f)
        fun still(at: Float) = Slide(at, at, 0L)
    }
}

/** What a debug build reports of the preview: the slot the gap is at (null at home), whether it opened, and the dimmed copy's place in window coordinates. */
internal class ReflowReport(val gap: BlockSlot?, val opened: Boolean, val copy: RectF?, val landing: Boolean)

internal class BlockReflowPreview private constructor(
    private val view: TextFirstEditText,
    private val block: LiftedBlock,
    private val book: SlotBook,
    /** A photo lifted out of its line, and that line. */
    private val photo: PhotoLine?,
) {
    /** The block's place: its lines, or for a photo its whole line; the slots at its edges. */
    private val topKey = BlockSlot(photo?.start ?: block.start, false)
    private val bottomKey = if (photo == null) BlockSlot(block.end, block.toEnd) else photo.below(view)

    /** The slot the gap is at; null at home (nothing moved). */
    var slot: BlockSlot? = null
        private set
    /** Whether the gap has moved since the lift: until then the note draws as it is, the block dimmed in place. */
    var opened = false
        private set
    /** Released: the copy is solid and nothing follows the finger. */
    private var released = false
    private var seed = false
    /** The layout changed since the slides were set: their shifts belong to the old one. */
    private var stale = false
    private var slides = TreeMap<BlockSlot, Slide>()
    private var copySlide = Slide.still(0f)
    private var restSlide = Slide.still(0f)
    private val fill = Paint()
    /** The note's drawing, recorded in tiles that every slice reuses (BlockReflowTiles.kt). */
    internal val tiles = SliceTiles(view)
    internal var landing: ReflowLanding? = null
    private var settled: (() -> Unit)? = null

    /** Whether the preview draws the note this frame (the view's own drawing does otherwise). */
    val drawing get() = opened || landing != null

    // ---- geometry, read from the layout as it is now ----

    private val end get() = view.length() - 1

    fun shape(): ReflowShape? {
        val top = view.boundaryY(topKey) ?: return null
        val bottom = view.boundaryY(bottomKey) ?: return null
        val p = photo ?: return ReflowShape(top, bottom, 0f, bottom - top)
        p.measure(view)
        return ReflowShape(top, bottom, p.restHeight, p.aloneHeight)
    }

    /** The offered slots near the screen, in order (kept as they arrive; the block's own edges are never offered). */
    private fun slots(): List<BlockSlot> = book.ordered

    private fun ys(list: List<BlockSlot>) = object : AbstractList<Float>() {
        override val size get() = list.size
        override fun get(index: Int) = view.boundaryY(list[index]) ?: Float.POSITIVE_INFINITY
    }

    fun gap(): ReflowGap = slot?.let { s -> view.boundaryY(s)?.let { ReflowGap.At(it, below = s >= bottomKey) } } ?: ReflowGap.Home

    /** The finger is at content y [finger]: move the gap by the rule. True when it reached a new slot (not home). */
    fun follow(finger: Float): Boolean {
        if (released) return false
        // The block's place is not laid out now (a new width cut the view to a prefix): nothing would show where it lands.
        val shape = shape() ?: run { if (slot != null) { slot = null; view.invalidate() }; return false }
        val list = slots()
        val stops = ReflowStops(shape, ys(list), photo != null)
        val index = slot?.let { list.binarySearch(it) } ?: -1
        val from = if (index < 0) stops.home else if (index < stops.home) index else index + 1
        // A neighbour still sliding counts where it is painted: the run below a stop starts at that slot (home: the block's bottom).
        val now = SystemClock.uptimeMillis()
        // A photo's line without it, still sliding, counts where it is painted too.
        val rest = if (photo != null && !stale && !seed) restSlide.at(now) else null
        val to = stops.walk(from, finger, { stop ->
            val key = if (stop == stops.home) bottomKey else list.getOrNull(if (stop < stops.home) stop else stop - 1)
            key?.takeIf { !stale }?.let { slides[it]?.at(now) }
        }, rest)
        if (to == from) return false
        slot = if (to == stops.home) null else list[if (to < stops.home) to else to - 1]
        if (!opened) { opened = true; seed = true }
        view.invalidate()
        return slot != null
    }

    // ---- drawing ----

    /** One slice of the note between two neighbouring stops: laid out from [top] to [bottom], kept by [key], the slot it starts at. */
    internal class Run(val key: BlockSlot, val top: Float, val bottom: Float, val endKey: BlockSlot)

    /** The slices that can show for a gap: those laid out within the shifts' reach of the screen, outside the block's place. */
    internal fun runs(shape: ReflowShape): List<Run> {
        val list = slots()
        val ys = ys(list)
        val reach = abs(shape.copy) + abs(shape.closes)
        val lo = view.scrollY - reach
        val hi = view.scrollY + view.height + reach
        val first = lowerBound(ys, lo)
        val last = lowerBound(ys, hi)
        val marks = ArrayList<Pair<BlockSlot, Float>>()
        marks += if (first > 0) list[first - 1] to ys[first - 1] else BlockSlot(0, false) to (view.boundaryY(BlockSlot(0, false)) ?: 0f)
        for (i in first until last) marks += list[i] to ys[i]
        marks += if (last < list.size) list[last] to ys[last] else BlockSlot(end, true) to (view.boundaryY(BlockSlot(end, true)) ?: hi)
        marks += topKey to shape.top
        marks += bottomKey to shape.bottom
        val sorted = marks.filter { it.second.isFinite() }.distinctBy { it.first }.sortedWith(compareBy({ it.second }, { it.first }))
        return sorted.zipWithNext().mapNotNull { (a, b) ->
            if (b.second <= a.second || (a.second >= shape.top && b.second <= shape.bottom)) null else Run(a.first, a.second, b.second, b.first)
        }
    }

    private fun lowerBound(ys: List<Float>, y: Float): Int {
        var lo = 0
        var hi = ys.size
        while (lo < hi) { val mid = (lo + hi) ushr 1; if (ys[mid] < y) lo = mid + 1 else hi = mid }
        return lo
    }

    /** Each run's shift drawn now, the copy's top and what stays of a photo's line, moved toward where [gap] puts them. */
    private fun place(shape: ReflowShape, gap: ReflowGap, runs: List<Run>, now: Long): List<Float> {
        val next = TreeMap<BlockSlot, Slide>()
        val shifts = runs.map { run ->
            val target = shape.shift(run.top, gap)
            val prior = when {
                seed -> Slide.still(0f)
                stale -> Slide.still(target)
                else -> slides[run.key] ?: slides.floorEntry(run.key)?.value ?: Slide.still(target)
            }
            prior.toward(target, now).also { next[run.key] = it }.at(now)
        }
        if (seed) { copySlide = Slide.still(shape.top); restSlide = Slide.still(shape.top); seed = false }
        if (stale) { copySlide = Slide.still(shape.copyTop(gap)); restSlide = Slide.still(shape.residueTop(gap)); stale = false }
        copySlide = copySlide.toward(shape.copyTop(gap), now)
        restSlide = restSlide.toward(shape.residueTop(gap), now)
        slides = next
        return shifts
    }

    private val moving get(): Boolean {
        val now = SystemClock.uptimeMillis()
        return copySlide.moving(now) || restSlide.moving(now) || slides.values.any { it.moving(now) }
    }

    /** Draw the note as previewed; false when the view's own drawing should (the preview is not open). */
    fun draw(canvas: Canvas): Boolean {
        landing?.let { if (it.draw(canvas)) return true else { landing = null; return false } }
        if (!opened) return false
        val shape = shape() ?: return false
        val now = SystemClock.uptimeMillis()
        val gap = gap()
        val runs = runs(shape)
        val shifts = place(shape, gap, runs, now)
        val top = view.scrollY.toFloat()
        val bottom = top + view.height
        for ((i, run) in runs.withIndex()) tiles.draw(canvas, run.top, run.bottom, shifts[i], top, bottom)
        val look = view.style
        val c = copySlide.at(now)
        val copy = when {
            photo == null -> {
                view.coverSlice(canvas, c, c + shape.copy, top, bottom)
                tiles.draw(canvas, shape.top, shape.bottom, c - shape.top, top, bottom)
                RectF(0f, c, view.width.toFloat(), c + shape.copy)
            }
            gap == ReflowGap.Home -> {
                tiles.draw(canvas, shape.top, shape.bottom, 0f, top, bottom)
                view.imageRect(photo.image)
            }
            else -> {
                val r = restSlide.at(now)
                view.coverSlice(canvas, r, r + shape.residue, top, bottom)
                photo.drawRest(canvas, view, r)
                view.coverSlice(canvas, c, c + shape.copy, top, bottom)
                photo.drawAlone(canvas, view, c)
                RectF(0f, c, view.width.toFloat(), c + shape.copy)
            }
        }
        if (!released && copy != null) {
            fill.color = (look.pageColor and 0x00ffffff) or (0xA6 shl 24)
            canvas.drawRect(copy.left, maxOf(copy.top, top), copy.right, minOf(copy.bottom, bottom), fill)
        }
        view.drawScrollEdge(canvas)
        tiles.trim()
        if (moving) view.postInvalidateOnAnimation() else settled?.let { done -> settled = null; view.post(done) }
        return true
    }

    // ---- the release ----

    /** The slot a release would drop on: the open gap, only while the preview can show it (a cut view may not hold it). */
    val target: BlockSlot? get() = slot?.takeIf { shape() != null && view.boundaryY(it) != null }

    /**
     * Released over [target]: the copy turns solid and the preview stays until the move lands.
     * Returns every paragraph on screen, with the slide that draws it, to find again in the
     * moved note (where each is drawn is read when the move lands, not now); null when nothing moves.
     */
    fun release(): ReflowCapture? {
        val s = target
        released = true
        view.invalidate()
        if (s == null) return null
        val shape = shape() ?: return null
        val e = view.editableText ?: return null
        val l = view.layout ?: return null
        val last = end
        val now = SystemClock.uptimeMillis()
        val gap = gap()
        val runs = runs(shape)
        // Released before a frame drew the open gap: everything starts where it was laid out.
        if (seed) place(shape, gap, runs, now)
        val below = s >= bottomKey
        val bandStart = topKey.offset
        val bandEnd = bottomKey.offset
        val stretch = if (below) bandStart else s.offset
        val blockParas = if (photo != null) 1 else reflowParagraphs(e, bandStart, bandEnd, last, bottomKey.end)
        val between = if (below) reflowParagraphs(e, bandEnd, s.offset, last, s.end) else reflowParagraphs(e, s.offset, bandStart, last, false)
        val move = ReflowMove(photo != null, below, blockParas, between)
        val top = view.scrollY.toFloat()
        val bottom = top + view.height
        val pieces = ArrayList<LandingPiece>()
        val ranked = ArrayList<Int>()
        fun next(p: Int) = e.indexOf('\n', p).let { if (it < 0 || it >= last) last else it + 1 }
        val emptyLast = last == 0 || e[last - 1] == '\n'
        for (run in runs) {
            val key = run.key
            val shift = slides[key]?.at(now) ?: shape.shift(run.top, gap)
            val a = maxOf(run.top, top - shift)
            val b = minOf(run.bottom, bottom - shift)
            if (b <= a) continue
            val first = l.getLineStart(l.getLineForVertical((a - view.totalPaddingTop).toInt().coerceAtLeast(0)))
            var p = maxOf(key.offset, e.lastIndexOf('\n', first - 1) + 1)
            val stop = minOf(run.endKey.offset, next(l.getLineStart(l.getLineForVertical((b - view.totalPaddingTop).toInt() - 1).coerceAtLeast(0))))
            // Each paragraph that shows; an empty last line (an empty task) only where the run reaches the note's end.
            while (p < stop || (p == last && p == stop && emptyLast && run.endKey.end)) {
                val n = next(p)
                val y = view.boundaryY(BlockSlot(p, false)) ?: break
                pieces += LandingPiece(p, n, { t -> y + (slides[key]?.at(t) ?: shift) }, -1, false, ReflowCapture.probe(e, p, last))
                if (p >= stretch) ranked += p
                if (n == p) break
                p = n
            }
        }
        // One pass over the stretch gives every shown paragraph its index in it.
        val rank = HashMap<Int, Int>()
        var k = 0
        var i = stretch
        for (at in ranked.distinct().sorted()) {
            while (i < at) { if (e[i] == '\n') k++; i++ }
            rank[at] = k
        }
        for (j in pieces.indices) rank[pieces[j].start]?.let { pieces[j] = pieces[j].landing(move.lands(it)) }
        if (photo == null) {
            var p = bandStart
            for (j in 0 until blockParas) {
                val y = view.boundaryY(BlockSlot(p, false)) ?: break
                pieces += LandingPiece(p, next(p), { t -> copySlide.at(t) + (y - shape.top) }, move.moved + j, true, ReflowCapture.probe(e, p, last))
                p = next(p)
            }
        } else {
            pieces += LandingPiece(-1, -1, { t -> copySlide.at(t) }, move.moved, true, ReflowCapture.probe(photo.text(e), 0, photo.text(e).length))
            pieces += LandingPiece(bandStart, bandEnd, { t -> restSlide.at(t) }, move.lands(if (below) 0 else between), false, ReflowCapture.probe(photo.rest(e), 0, photo.rest(e).length))
        }
        return ReflowCapture(tiles, stretch, pieces, view.scrollY, now)
    }

    /** Nothing moves: what slid goes back to its place, then [done] (at once when nothing slid). */
    fun settleHome(done: () -> Unit) {
        released = true
        slot = null
        landing = null
        if (!opened) return done()
        settled = done
        view.invalidate()
        view.postDelayed({ settled?.let { settled = null; it() } }, ReflowCapture.LANDING_CAP_MS)
    }

    /** How much taller the preview draws the note than it is laid out (a photo leaving a row a sibling keeps tall): autoscroll reaches that far. */
    fun extraHeight(): Int {
        // Only while a gap is drawn: a photo back home in its line adds nothing.
        if (!opened || released || slot == null) return 0
        val shape = shape() ?: return 0
        return kotlin.math.ceil(shape.copy - shape.closes).toInt().coerceAtLeast(0)
    }

    /** The layout changed (a photo decoded, a new width): what was recorded from it is drawn again. */
    fun remeasure() {
        if (opened && landing == null) stale = true
        tiles.clear()
        photo?.invalidate()
    }

    fun report(): ReflowReport {
        val shape = shape()
        val at = IntArray(2).also(view::getLocationInWindow)
        // During the landing, the moved block as the landing draws it; a photo back home, its own box in its line.
        val content = landing?.movedBlock() ?: when {
            shape == null || !opened -> null
            photo != null && gap() == ReflowGap.Home -> view.imageRect(photo.image)
            else -> copySlide.at(SystemClock.uptimeMillis()).let { c -> RectF(0f, c, view.width.toFloat(), c + shape.copy) }
        }
        val copy = content?.apply { offset(at[0].toFloat(), at[1].toFloat() - view.scrollY) }
        return ReflowReport(slot, opened, copy, landing != null)
    }

    companion object {
        /** The preview for [block], or null with the reason it cannot be drawn (the drag then uses the drop line). */
        fun build(view: TextFirstEditText, block: LiftedBlock, book: SlotBook, image: TfImage?): Pair<BlockReflowPreview?, String?> {
            if (view.layout == null) return null to "the note has no layout"
            val photo = if (image == null) null else try {
                PhotoLine.of(view, image) ?: return null to "the photo's line could not be found"
            } catch (e: RuntimeException) {
                return null to "the photo's line could not be laid out without it: $e"
            }
            val preview = BlockReflowPreview(view, block, book, photo)
            if (preview.shape() == null) return null to "the block's place is not laid out"
            return preview to null
        }
    }
}

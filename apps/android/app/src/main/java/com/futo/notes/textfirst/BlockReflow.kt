package com.futo.notes.textfirst

// The reflow preview's geometry (#450), pure: where the gap is as the finger moves, and where
// each part of the note is drawn for it. Content y (the layout's plus the top padding). The view
// side (BlockReflowPreview.kt) reads the layout and draws; nothing here knows a View.

/** Where the gap is: the block's own place (nothing moved), or the boundary laid out at [y], after the block's place when [below]. */
internal sealed class ReflowGap {
    object Home : ReflowGap() { override fun toString() = "Home" }
    data class At(val y: Float, val below: Boolean) : ReflowGap()
}

/**
 * The note as the preview draws it for a block laid out from [top] to [bottom]. Its place keeps
 * [residue] of that height (none for whole lines; for a photo lifted out of its line, the line
 * laid out without it) and the gap is [copy] tall. Everything else is drawn as laid out, moved
 * by [shift]: between the block and the gap up (or down) by what closes, past both by the
 * difference between the gap and what closed.
 */
internal class ReflowShape(val top: Float, val bottom: Float, val residue: Float, val copy: Float) {
    /** How far the block's place closes. */
    val closes get() = bottom - top - residue

    /** How far content laid out from [y] down (outside the block's place) is drawn from there. */
    fun shift(y: Float, gap: ReflowGap): Float = when (gap) {
        ReflowGap.Home -> 0f
        is ReflowGap.At -> if (gap.below) when {
            y < top -> 0f
            y < gap.y -> -closes
            else -> copy - closes
        } else when {
            y < gap.y -> 0f
            y < top -> copy
            else -> copy - closes
        }
    }

    /** Where the copy's top is drawn: at home, the block's own place. */
    fun copyTop(gap: ReflowGap): Float = when (gap) {
        ReflowGap.Home -> top
        is ReflowGap.At -> if (gap.below) gap.y - closes else gap.y
    }

    /** Where what stays of the block's place (its line without the photo) is drawn. */
    fun residueTop(gap: ReflowGap): Float = when (gap) {
        ReflowGap.Home -> top
        is ReflowGap.At -> if (gap.below) top else top + copy
    }

    /** Where [y] is drawn: inside the block's place, the same fraction down what stays of it (the place itself at home). */
    fun drawn(y: Float, inPlace: Boolean, gap: ReflowGap, restTop: Float? = null): Float = when {
        !inPlace -> y + shift(y, gap)
        gap == ReflowGap.Home -> y
        else -> (restTop ?: residueTop(gap)) + (y - top) * residue / maxOf(1f, bottom - top)
    }
}

/**
 * The places the gap may be, in order: each slot offered near the screen, laid out at [slots]
 * (ascending, the block's own edges left out), and the block's own place (index [home]). The
 * content between two neighbouring stops is a run: the gap moves past a run when the finger
 * passes its middle as drawn for the gap open now, so a run passed is drawn on the far side of
 * the gap and the gap cannot flick back. A stretch with no slot (a quote, code, a table) is one
 * run. A photo lifted out of its line has both edges of its line as slots, and its own place is
 * the middle of that line: what stays of the line (drawn without it) is split in two around home.
 */
internal class ReflowStops(private val shape: ReflowShape, private val slots: List<Float>, private val photo: Boolean) {
    /** The slots at or above the block's top come before its place (read lazily: a long drag's book is long). */
    val home: Int = run {
        var lo = 0
        var hi = slots.size
        while (lo < hi) { val mid = (lo + hi) ushr 1; if (slots[mid] <= shape.top) lo = mid + 1 else hi = mid }
        lo
    }
    val size get() = slots.size + 1

    fun gap(stop: Int): ReflowGap = if (stop == home) ReflowGap.Home else ReflowGap.At(y(stop), below = stop > home)

    private fun y(stop: Int) = slots[if (stop < home) stop else stop - 1]

    /** A stop's upper and lower edges, as laid out. */
    private fun upper(stop: Int) = if (stop != home) y(stop) else if (photo) middle else shape.top
    private fun lower(stop: Int) = if (stop != home) y(stop) else if (photo) middle else shape.bottom
    private val middle get() = (shape.top + shape.bottom) / 2

    /**
     * The middle of the run below [stop], as drawn with the gap at [at]. A photo at home in its
     * line leaves it only past the line's top or bottom, so nothing moves at the lift.
     */
    private fun runMiddle(stop: Int, at: ReflowGap, painted: Float? = null, restTop: Float? = null): Float {
        if (photo && at == ReflowGap.Home) {
            if (stop + 1 == home) return shape.top
            if (stop == home) return shape.bottom
        }
        val a = lower(stop)
        val b = upper(stop + 1)
        val inPlace = photo && a >= shape.top && b <= shape.bottom
        if (inPlace) return (shape.drawn(a, true, at, restTop) + shape.drawn(b, true, at, restTop)) / 2
        val shift = painted ?: shape.shift(a, at)
        return (a + b) / 2 + shift
    }

    /**
     * Where the gap goes from [from] for a finger at [finger]: past each run whose middle the
     * finger passed, one way. [drawn] gives the shift the run below a stop is painted with now
     * (null: settled at its place for the open gap), so a neighbour still sliding counts where it
     * shows; runs past it are judged where the gap's next steps would put them.
     */
    fun walk(from: Int, finger: Float, drawn: ((Int) -> Float?)? = null, restTop: Float? = null): Int {
        val start = from.coerceIn(0, size - 1)
        var stop = start
        fun painted(run: Int) = if (stop == start) drawn?.invoke(run) else null
        // [restTop]: where a photo's line without it is painted now, for the open gap only.
        fun rest() = if (stop == start) restTop else null
        while (stop + 1 < size && finger > runMiddle(stop, gap(stop), painted(stop), rest())) stop++
        if (stop != start) return stop
        while (stop > 0 && finger < runMiddle(stop - 1, gap(stop), painted(stop - 1), rest())) stop--
        return stop
    }
}

/**
 * Where each paragraph of the stretch a move rewrites lands, counted from the stretch's first
 * paragraph (the block's or the gap's, whichever is higher): the [block]'s paragraphs (for a
 * photo, its line) and the [between] paragraphs trade places, or a photo leaves its line and
 * becomes a line of its own. A move writes whole lines and never adds a blank one
 * (block-movement.md), so a paragraph is followed by its index.
 */
internal class ReflowMove(private val photo: Boolean, private val below: Boolean, private val block: Int, private val between: Int) {
    /** Where the block's first paragraph (a photo's own line) lands. */
    val moved get() = if (below) between + (if (photo) 1 else 0) else 0

    fun lands(k: Int): Int = when {
        photo && below -> if (k < 1 + between) k else k + 1
        photo -> k + 1
        below -> if (k < block) between + k else if (k < block + between) k - block else k
        else -> if (k < between) k + block else if (k < block + between) k - between else k
    }
}

/**
 * Paragraphs in display range [a, b) of [text] whose last line ends at [last]. [toEnd] when [b]
 * is the note's end slot: the last line counts then even when it shows no characters (an empty
 * line; an empty list item shows its marker unit), whose top boundary shares its offset.
 */
internal fun reflowParagraphs(text: CharSequence, a: Int, b: Int, last: Int, toEnd: Boolean): Int {
    var n = 0
    for (i in a until b) if (text[i] == '\n') n++
    val lastLine = b == last && (if (b > a) text[b - 1] != '\n' || toEnd else toEnd)
    return if (lastLine) n + 1 else n
}

/**
 * Whether a landing paragraph from [from] to [to] of [text] (last line ending at [last]) is
 * bottomed by the note's end slot: only when it is the last line itself, never a paragraph that
 * ends where an empty last line starts, whose bottom is that line's top.
 */
internal fun endsAtNoteEnd(text: CharSequence, from: Int, to: Int, last: Int): Boolean =
    to >= last && !(from < last && last > 0 && text[last - 1] == '\n')

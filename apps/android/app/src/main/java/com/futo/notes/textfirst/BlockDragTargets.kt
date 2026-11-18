package com.futo.notes.textfirst

import kotlin.math.abs

// Where a lifted block may land (#311, #444). The engine names the block and its slots; the
// view keeps the slots by their place in the text, never by where they were drawn at the lift,
// asks the engine only for the stretch of note that newly comes near the screen, and reads
// where each is drawn from the current layout whenever it is needed (BlockDrag.kt). The reflow
// preview (#450) reads the same book. UTF-16 display offsets throughout.

/**
 * A boundary a block may land on: above the line starting at [offset], or, when [end], below
 * the note's last line ([offset] is then the display's end). Around a last line that shows no
 * characters (an empty task) the two share [offset]; [end] tells them apart.
 */
internal data class BlockSlot(val offset: Int, val end: Boolean) : Comparable<BlockSlot> {
    override fun compareTo(other: BlockSlot): Int =
        if (offset != other.offset) offset.compareTo(other.offset) else end.compareTo(other.end)
}

/** What a press lifts: its display range, and whether its bottom edge is the note's end. */
internal data class LiftedBlock(val start: Int, val end: Int, val toEnd: Boolean)

/**
 * One lifted block's slots, kept by slot: the engine's answers so far and the stretch of note
 * they cover. As the note scrolls only what newly comes near the screen is asked for, so a long
 * drag costs what the scrolled stretch costs, never the whole note.
 */
internal class SlotBook {
    /** The stretch asked for so far, both ends included as the engine reads a range. */
    var covered: IntRange? = null
        private set
    private val known = sortedSetOf<BlockSlot>()
    val slots: List<BlockSlot> get() = known.toList()

    /**
     * The stretches of [range] not asked for yet, and the stretch covered once they are:
     * kept in one piece, so a jump past what was covered asks for the gap too.
     */
    fun missing(range: IntRange): Pair<List<IntRange>, IntRange> {
        val have = covered ?: return listOf(range) to range
        val asks = buildList {
            if (range.first < have.first) add(range.first..have.first)
            if (range.last > have.last) add(have.last..range.last)
        }
        return asks to minOf(range.first, have.first)..maxOf(range.last, have.last)
    }

    /** Take the engine's answers, now covering [covering]. */
    fun add(found: List<BlockSlot>, covering: IntRange) {
        covered = covering
        known.addAll(found)
    }

    /** The slots whose offsets lie in [range] (both ends included), in display order. */
    fun slotsIn(range: IntRange): List<BlockSlot> =
        known.subSet(BlockSlot(range.first, false), true, BlockSlot(range.last, true), true).toList()
}

/**
 * Where a lifted block may land as drawn now: each slot on screen with the y of its boundary,
 * and the block's own top and bottom edges as far as they show, where a drop would change
 * nothing (null when no part of it shows). A photo lifted out of its line has no edges of its
 * own (every slot moves it, its line's edges too): both are its middle, so held where it was
 * it drops nowhere.
 */
internal class DropTargets(val slots: List<Pair<BlockSlot, Float>>, val own: Pair<Float, Float>?) {
    /** The slot nearest [y]; null when one of the block's own edges is nearer. */
    fun nearest(y: Float): Pair<BlockSlot, Float>? {
        val best = slots.minByOrNull { abs(it.second - y) } ?: return null
        val (top, bottom) = own ?: return best
        return if (abs(best.second - y) < minOf(abs(top - y), abs(bottom - y))) best else null
    }
}

/**
 * The edge autoscroll of a block drag, as the web editor's (blockDragGeometry.ts): held within
 * [ZONE_DP] of the visible note's top or bottom the note scrolls, [SLOWEST_DP] per second at
 * the zone's inner lip ramping to [FASTEST_DP] at the edge and past it, one frame's step capped
 * at [LONGEST_STEP_S]. Where the note shows less than two zones the nearer edge wins.
 */
internal object BlockAutoscroll {
    const val ZONE_DP = 64f
    const val SLOWEST_DP = 200f
    const val FASTEST_DP = 1400f
    const val LONGEST_STEP_S = 0.05f

    /** Pixels per second (negative scrolls towards the top) for a finger at [y] in [top]..[bottom]. */
    fun velocity(y: Float, top: Float, bottom: Float, density: Float): Float {
        val zone = ZONE_DP * density
        val fromTop = y - top
        val fromBottom = bottom - y
        fun speed(distance: Float) =
            (SLOWEST_DP + (FASTEST_DP - SLOWEST_DP) * ((zone - distance) / zone).coerceIn(0f, 1f)) * density
        if (fromTop < zone && fromTop <= fromBottom) return -speed(fromTop)
        if (fromBottom < zone) return speed(fromBottom)
        return 0f
    }

    /** How far one frame scrolls at [velocity], [elapsedS] seconds after the last. */
    fun step(velocity: Float, elapsedS: Float): Float = velocity * elapsedS.coerceIn(0f, LONGEST_STEP_S)
}

package com.futo.notes.textfirst

/** A code block's code in display offsets: its first code line's start to its last code line's end. */
internal data class CodeRange(val start: Int, val end: Int)

/**
 * !300's one rule for every selection near code (cb 110-130, 880-893): a selection whose anchor is in
 * a block's code is a selection within that code, both ends clamped to it; otherwise every block the
 * range reaches into is taken whole. A range that only meets a block's edge takes none of it, and an
 * empty block has no inside, so a press there takes it. [blocks] are the blocks near the range, in
 * order. Returns the range, start first.
 */
internal fun resolveCodeSelection(anchor: Int, head: Int, blocks: List<CodeRange>): Pair<Int, Int> {
    val home = blocks.firstOrNull { it.start < it.end && anchor >= it.start && anchor <= it.end }
    if (home != null) {
        val clamped = head.coerceIn(home.start, home.end)
        return minOf(anchor, clamped) to maxOf(anchor, clamped)
    }
    var from = minOf(anchor, head)
    var to = maxOf(anchor, head)
    if (from == to) return from to to
    for (block in blocks) {
        // Made from the line below, a range that only meets a block's end starts past its line break: it never ends
        // at the block's last code position, holding only that break (Mason's rule).
        if (block.start < block.end && from == block.end && anchor > block.end && to > from) { from = block.end + 1; continue }
        val reached = if (block.start == block.end) (from < block.start && to > block.start) || anchor == block.start
            else from < block.end && to > block.start
        if (!reached) continue
        from = minOf(from, block.start)
        to = maxOf(to, block.end)
    }
    return from to to
}

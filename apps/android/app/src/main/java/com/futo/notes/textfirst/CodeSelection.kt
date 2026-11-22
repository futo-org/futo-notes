package com.futo.notes.textfirst

/** A code block's code in display offsets: its first code line's start to its last code line's end. */
internal data class CodeRange(val start: Int, val end: Int)

/**
 * The one rule for every selection near code: a selection with both ends in one block's code is a
 * selection within that code; otherwise every block the range reaches into is taken whole, so a
 * handle carried out of a block takes the selection with it. A range that only meets a block's edge
 * takes none of it, and an empty block has no inside, so a press there takes it. [blocks] are the
 * blocks near the range, in order. Returns the range, start first.
 */
internal fun resolveCodeSelection(anchor: Int, head: Int, blocks: List<CodeRange>): Pair<Int, Int> {
    val home = blocks.firstOrNull { it.start < it.end && anchor >= it.start && anchor <= it.end }
    if (home != null && head >= home.start && head <= home.end) return minOf(anchor, head) to maxOf(anchor, head)
    var from = minOf(anchor, head)
    var to = maxOf(anchor, head)
    if (from == to) return from to to
    for (block in blocks) {
        // A range that only meets a block's end starts past its line break, never holding only that break (Mason's
        // rule): the engine maps the code's end to past the closing fence, so the break is nothing to copy. This
        // repeats the engine's display-to-source mapping (source_selection) for the paint.
        if (block.start < block.end && from == block.end && to > from) { from = block.end + 1; continue }
        val reached = if (block.start == block.end) (from < block.start && to > block.start) || anchor == block.start
            else from < block.end && to > block.start
        if (!reached) continue
        from = minOf(from, block.start)
        to = maxOf(to, block.end)
    }
    return from to to
}

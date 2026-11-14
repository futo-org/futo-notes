package com.futo.notes.textfirst

/**
 * The display edits behind each view update the engine posted, so a touch
 * selection the view made against an older update still lands where the
 * user touched. The editor thread runs the user's actions in the order they
 * were posted; a tap queued behind a long command is the newer action and
 * must not be discarded because that command bumped the update number
 * (otherwise the next key replaces the selection the user moved away from).
 * Editor thread only.
 */
internal class ViewEditJournal(private val capacity: Int = 512) {
    private class Entry(val seq: Int, val starts: IntArray, val ends: IntArray, val lengths: IntArray)

    private val entries = ArrayDeque<Entry>()
    /** Views at an update below this cannot be mapped: their text is unrelated or forgotten. */
    private var floor = 0
    private var broken = false

    /** The next recorded update replaces the view's text with no edit correspondence. */
    fun discontinue() { broken = true }

    fun record(seq: Int, edits: List<TextEdit>) {
        if (broken) {
            broken = false
            entries.clear()
            floor = seq
            return
        }
        if (edits.isEmpty()) return
        entries.addLast(Entry(seq,
            IntArray(edits.size) { edits[it].start },
            IntArray(edits.size) { edits[it].end },
            IntArray(edits.size) { edits[it].text.length }))
        while (entries.size > capacity) floor = entries.removeFirst().seq
    }

    /**
     * [start]/[end] of a view that had applied update [viewSeq], in the
     * display coordinates of the latest update, or null when that view's
     * text no longer corresponds.
     */
    fun map(viewSeq: Int, start: Int, end: Int): Pair<Int, Int>? {
        if (viewSeq < floor) return null
        // Views only move forward: nothing older will be asked again.
        while (entries.isNotEmpty() && entries.first().seq <= viewSeq) entries.removeFirst()
        var a = start
        var b = end
        for (entry in entries) for (i in entry.starts.indices) {
            a = moved(a, entry.starts[i], entry.ends[i], entry.lengths[i])
            b = moved(b, entry.starts[i], entry.ends[i], entry.lengths[i])
        }
        return minOf(a, b) to maxOf(a, b)
    }

    private fun moved(at: Int, start: Int, end: Int, length: Int): Int = when {
        at <= start -> at
        at >= end -> at + length - (end - start)
        // Inside replaced text: the same distance in, as far as the new text reaches.
        else -> start + minOf(at - start, length)
    }
}

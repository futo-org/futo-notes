package com.futo.notes.textfirst

/**
 * One find result as the engine published it: display UTF-16 ranges from the
 * canonical find rules. [matches] are (start, end) pairs, ascending and
 * non-overlapping; [current] is one-based, zero for none.
 */
internal class FindSnapshot(
    val open: Boolean,
    val query: String,
    val total: Int,
    val current: Int,
    val stale: Boolean,
    val matches: List<Pair<Int, Int>>,
    /** Set only when the call moved the current match: scroll it into view. */
    val reveal: Pair<Int, Int>? = null,
) {
    companion object { val Closed = FindSnapshot(false, "", 0, 0, false, emptyList()) }
}

/** The ranges the view paints behind text and inside table cells. No Markdown meaning. */
internal class FindMarks {
    @Volatile private var starts = IntArray(0)
    @Volatile private var ends = IntArray(0)
    @Volatile var current = -1; private set

    fun set(snapshot: FindSnapshot) {
        val matches = if (snapshot.open) snapshot.matches else emptyList()
        starts = IntArray(matches.size) { matches[it].first }
        ends = IntArray(matches.size) { matches[it].second }
        current = if (snapshot.current in 1..matches.size) snapshot.current - 1 else -1
    }

    val isEmpty: Boolean get() = starts.isEmpty()

    /** Calls [paint] for each match overlapping [from, to). */
    fun visit(from: Int, to: Int, paint: (start: Int, end: Int, current: Boolean) -> Unit) {
        val s = starts; val e = ends
        var lo = 0; var hi = s.size
        while (lo < hi) { val mid = (lo + hi) ushr 1; if (e[mid] <= from) lo = mid + 1 else hi = mid }
        var i = lo
        while (i < s.size && s[i] < to) { paint(s[i], e[i], i == current); i++ }
    }
}

/** A cell's native Layout owns wrapping and bidi selection geometry in both grid and field. */
internal fun FindMarks.drawCell(canvas: android.graphics.Canvas, layout: android.text.Layout,
    from: Int, to: Int, style: TextFirstStyle) {
    if (isEmpty) return
    val path = android.graphics.Path()
    val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
    visit(from, to) { start, end, current ->
        val a = (start - from).coerceIn(0, layout.text.length)
        val b = (end - from).coerceIn(0, layout.text.length)
        if (b <= a) return@visit
        path.rewind()
        layout.getSelectionPath(a, b, path)
        paint.color = style.findMarkColor(current)
        canvas.drawPath(path, paint)
    }
}

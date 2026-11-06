package com.futo.notes.textfirst

import android.text.Editable
import android.text.GetChars
import android.text.InputFilter
import android.text.SpanWatcher
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextWatcher
import android.text.style.LineBackgroundSpan

/**
 * The Editable behind the text-first view, built so a keystroke's cost does
 * not grow with the note.
 *
 * Android's [SpannableStringBuilder] does whole-buffer work on every edit:
 * it walks every span to shift it, asks for watchers once per shifted span,
 * and rebuilds its interval tree; Layout then queries line backgrounds over
 * the whole text on every frame. With the ~20k spans of a 19k-line corpus
 * note that was over 150 ms a keystroke on the Moto, and with every watcher
 * told about every shifted span, over a minute.
 *
 * So the text is split into chunks of whole lines, each its own small
 * builder holding the spans that START in it. Renderer spans never cross a
 * line (planSpans cuts them per line), so an edit touches one chunk; a
 * query skips chunks that hold no span of the asked-for kind. Watchers that
 * TextView and its layout attach live outside the chunks and hear only what
 * actually happened: the replaced range, and spans explicitly set or
 * removed — never spans that merely moved with the text.
 *
 * A span that does cross chunks (something the platform sets, or a
 * multi-line paste) merges the chunks it touches, so correctness never
 * depends on the per-line rule; only speed does.
 */
internal class ChunkedEditable private constructor(private val target: Int, private val max: Int) : ReplaceEditable(), GetChars {
    internal val chunks = ArrayList<EditableChunk>()
    internal var offsets = IntArray(1)
    private var total = 0
    internal val home = HashMap<Any, EditableChunk>()

    internal val textWatchers = ArrayList<TextWatcher>()
    internal var rendererChange: RendererChange? = null
    internal val spanWatchers = ArrayList<SpanWatcher>()
    private val watcherFlags = LinkedHashMap<Any, Int>()
    private var filters: Array<InputFilter> = emptyArray()
    /** Spans with SPAN_PRIORITY bits; while there are none, queries skip the priority sort. */
    private var prioritized = 0
    /**
     * While the view draws: the characters on screen. Layout.drawBackground
     * asks for line backgrounds over the whole text every frame, but draws
     * only visible lines, so those queries are clamped here.
     */
    var drawWindow: IntRange? = null

    // ---- chunk bookkeeping ----

    private fun reindex() {
        if (offsets.size != chunks.size + 1) offsets = IntArray(chunks.size + 1)
        var at = 0
        for (i in chunks.indices) { offsets[i] = at; at += chunks[i].text.length }
        offsets[chunks.size] = at
        total = at
    }

    /** The chunk an offset belongs to: the last whose start is <= offset (the final chunk owns the end). */
    private fun chunkAt(offset: Int): Int {
        var lo = 0
        var hi = chunks.size - 1
        while (lo < hi) {
            val mid = (lo + hi + 1) ushr 1
            if (offsets[mid] <= offset) lo = mid else hi = mid - 1
        }
        return lo
    }

    internal fun indexOf(chunk: EditableChunk): Int {
        // Chunks are few (a 500 KB note has ~100); identity scan is fine.
        for (i in chunks.indices) if (chunks[i] === chunk) return i
        error("chunk not found")
    }

    /** Merge chunks [first..last] into one; returns its index. */
    private fun merge(first: Int, last: Int): Int {
        if (first == last) return first
        // All text first: a point span at a chunk's end would otherwise ride
        // along with the next chunk's appended text.
        val merged = SpannableStringBuilder((first..last).joinToString("") { chunks[it].text.toString() })
        val into = EditableChunk(merged)
        var base = 0
        for (i in first..last) {
            val c = chunks[i]
            for (span in c.text.getSpans(0, c.text.length, Any::class.java)) {
                merged.setSpan(span, base + c.text.getSpanStart(span), base + c.text.getSpanEnd(span), c.text.getSpanFlags(span))
                home[span] = into
                into.added(span)
            }
            base += c.text.length
        }
        for (i in last downTo first + 1) chunks.removeAt(i)
        chunks[first] = into
        reindex()
        return first
    }

    /** Split an oversized chunk at line starts so each part stays near [TARGET]. */
    private fun splitIfLarge(index: Int) {
        val chunk = chunks[index]
        if (chunk.text.length <= max) return
        val text = chunk.text.toString()
        val cuts = ArrayList<Int>()
        var from = 0
        while (text.length - from > max) {
            var cut = text.indexOf('\n', from + target)
            if (cut < 0 || cut + 1 >= text.length) break
            cut += 1
            cuts.add(cut)
            from = cut
        }
        if (cuts.isEmpty()) return
        val bounds = listOf(0) + cuts + listOf(text.length)
        val parts = (0 until bounds.size - 1).map { EditableChunk(SpannableStringBuilder(text.substring(bounds[it], bounds[it + 1]))) }
        for (span in chunk.text.getSpans(0, chunk.text.length, Any::class.java)) {
            val s = chunk.text.getSpanStart(span)
            val e = chunk.text.getSpanEnd(span)
            val flags = chunk.text.getSpanFlags(span)
            // The part holding the span's start (the last part owns the very end).
            var p = java.util.Collections.binarySearch(bounds, s).let { if (it >= 0) it else -it - 2 }
            p = p.coerceIn(0, parts.size - 1)
            // A span that does not fit its start's part keeps the chunk whole.
            if (e > bounds[p + 1]) return
            parts[p].text.setSpan(span, s - bounds[p], e - bounds[p], flags)
        }
        for (part in parts) for (span in part.text.getSpans(0, part.text.length, Any::class.java)) {
            home[span] = part
            part.added(span)
        }
        chunks.removeAt(index)
        chunks.addAll(index, parts)
        reindex()
    }

    // ---- Spanned ----

    override fun setSpan(what: Any, start: Int, end: Int, flags: Int) {
        require(start in 0..end && end <= total) { "span $start..$end outside 0..$total" }
        if (what is TextWatcher || what is SpanWatcher) {
            if (what is TextWatcher && what !in textWatchers) textWatchers.add(what)
            if (what is SpanWatcher && what !in spanWatchers) spanWatchers.add(what)
            watcherFlags[what] = flags
            orderWatcherCallbacks(textWatchers, spanWatchers, watcherFlags)
            return
        }
        // SpannableStringBuilder ignores an empty exclusive span (the old one, if any, stays).
        if (start == end && (flags and Spanned.SPAN_POINT_MARK_MASK) == Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) return
        val old = home[what]
        val oldStart = if (old != null) getSpanStart(what) else -1
        val oldEnd = if (old != null) getSpanEnd(what) else -1
        if (old != null) {
            if (old.text.getSpanFlags(what) and Spanned.SPAN_PRIORITY != 0) prioritized -= 1
            old.text.removeSpan(what)
            old.removed(what)
            home.remove(what)
        }
        var first = chunkAt(start)
        val last = chunkAt(if (end > start) end - 1 else end)
        if (last != first) first = merge(first, last)
        val chunk = chunks[first]
        chunk.text.setSpan(what, start - offsets[first], end - offsets[first], flags)
        if (flags and Spanned.SPAN_PRIORITY != 0) prioritized += 1
        chunk.added(what)
        home[what] = chunk
        if (rendererChange == null || what !is TfSpan) {
            val watchers = spanWatchers.toTypedArray()
            if (old == null) for (w in watchers) w.onSpanAdded(this, what, start, end)
            else for (w in watchers) w.onSpanChanged(this, what, oldStart, oldEnd, start, end)
        }
        if (last != first || chunk.text.length > max) splitIfLarge(indexOf(chunk))
    }

    override fun removeSpan(what: Any) {
        if (what is TextWatcher || what is SpanWatcher) {
            textWatchers.remove(what)
            spanWatchers.remove(what)
            watcherFlags.remove(what)
            return
        }
        val chunk = home[what] ?: return
        val start = getSpanStart(what)
        val end = getSpanEnd(what)
        if (chunk.text.getSpanFlags(what) and Spanned.SPAN_PRIORITY != 0) prioritized -= 1
        chunk.text.removeSpan(what)
        chunk.removed(what)
        home.remove(what)
        if (rendererChange == null || what !is TfSpan) {
            for (w in spanWatchers.toTypedArray()) w.onSpanRemoved(this, what, start, end)
        }
    }

    override fun getSpanStart(tag: Any): Int {
        if (tag in watcherFlags) return 0
        val chunk = home[tag] ?: return -1
        return offsets[indexOf(chunk)] + chunk.text.getSpanStart(tag)
    }

    override fun getSpanEnd(tag: Any): Int {
        if (tag in watcherFlags) return total
        val chunk = home[tag] ?: return -1
        return offsets[indexOf(chunk)] + chunk.text.getSpanEnd(tag)
    }

    override fun getSpanFlags(tag: Any): Int = watcherFlags[tag] ?: home[tag]?.text?.getSpanFlags(tag) ?: 0

    @Suppress("UNCHECKED_CAST")
    override fun <T : Any?> getSpans(start: Int, end: Int, kind: Class<T>?): Array<T> {
        val type = (kind ?: Any::class.java) as Class<Any>
        val window = drawWindow?.takeIf { type == LineBackgroundSpan::class.java }
        val queryStart = if (window != null) maxOf(start, window.first) else start
        val queryEnd = if (window != null) minOf(end, window.last) else end
        val out = ArrayList<Any>()
        if (chunks.isNotEmpty() && queryStart <= queryEnd) {
            val first = chunkAt(maxOf(0, queryStart - 1))
            val last = chunkAt(minOf(total, queryEnd))
            for (i in first..last) {
                val chunk = chunks[i]
                if (!chunk.hasKind(type)) continue
                val base = offsets[i]
                val len = chunk.text.length
                val candidates = chunk.text.getSpans((queryStart - base).coerceIn(0, len), (queryEnd - base).coerceIn(0, len), type)
                for (span in candidates) {
                    val s = base + chunk.text.getSpanStart(span)
                    val e = base + chunk.text.getSpanEnd(span)
                    // SpannableStringBuilder's own rule, on absolute offsets.
                    if (s > queryEnd || e < queryStart) continue
                    if (s != e && queryStart != queryEnd && (s == queryEnd || e == queryStart)) continue
                    out.add(span)
                }
            }
        }
        var sort = prioritized > 0
        for ((w, f) in watcherFlags) if (type.isInstance(w)) {
            out.add(w)
            sort = sort || f and Spanned.SPAN_PRIORITY != 0
        }
        val array = java.lang.reflect.Array.newInstance(kind ?: Any::class.java, out.size) as Array<T>
        for (i in out.indices) array[i] = out[i] as T
        if (sort && out.size > 1) {
            // Higher SPAN_PRIORITY first, as SpannableStringBuilder orders them.
            java.util.Arrays.sort(array) { a, b ->
                (getSpanFlags(b as Any) and Spanned.SPAN_PRIORITY) - (getSpanFlags(a as Any) and Spanned.SPAN_PRIORITY)
            }
        }
        return array
    }

    override fun nextSpanTransition(start: Int, limit: Int, kind: Class<*>?): Int {
        val type = kind ?: Any::class.java
        if (chunks.isEmpty() || start >= limit) return limit
        var i = chunkAt(maxOf(0, start))
        while (i < chunks.size && offsets[i] < limit) {
            val chunk = chunks[i]
            val base = offsets[i]
            if (chunk.hasKind(type)) {
                val localStart = if (start < base) -1 else start - base
                val localLimit = minOf(limit - base, chunk.text.length)
                val next = chunk.text.nextSpanTransition(localStart, localLimit, type)
                if (next < localLimit) return maxOf(base + next, start + 1)
                // A span ending exactly at this chunk's end is a transition there.
                if (localLimit == chunk.text.length && base + localLimit < limit && base + localLimit > start &&
                    chunk.text.getSpans(localLimit, localLimit, type).any { chunk.text.getSpanEnd(it) == localLimit }
                ) return base + localLimit
            }
            i++
        }
        return limit
    }

    // ---- text ----

    override fun replace(st: Int, en: Int, source: CharSequence, start: Int, end: Int): Editable {
        var text: CharSequence = source.subSequence(start, end)
        for (filter in filters) filter.filter(text, 0, text.length, this, st, en)?.let { text = it }
        val before = en - st
        val after = text.length
        if (before == 0 && after == 0) return this
        val watchers = if (rendererChange == null) textWatchers.toTypedArray() else emptyArray()
        for (w in watchers) w.beforeTextChanged(this, st, before, after)
        var first = chunkAt(st)
        val last = chunkAt(en)
        // An edit ending exactly at the next chunk's start stays in this chunk.
        val lastNeeded = if (last > first && offsets[last] == en) last - 1 else last
        if (lastNeeded != first) first = merge(first, lastNeeded)
        val chunk = chunks[first]
        val base = offsets[first]
        // SpannableStringBuilder drops exclusive spans an edit empties; note
        // which could be, so they leave the index too.
        val exposed = if (before > 0) chunk.text.getSpans(st - base, en - base, Any::class.java)
            .map { Triple(it, base + chunk.text.getSpanStart(it), base + chunk.text.getSpanEnd(it)) } else emptyList()
        if (text is Spanned) {
            // Inserted spans would land here unindexed; renderer edits are plain text.
            chunk.text.replace(st - base, en - base, text.toString())
        } else {
            chunk.text.replace(st - base, en - base, text)
        }
        val dropped = exposed.filter { chunk.text.getSpanStart(it.first) < 0 }
        for ((span, _, _) in dropped) { chunk.removed(span); home.remove(span) }
        // A point the edit pushed to this chunk's very end belongs to the next
        // chunk, where text typed at that offset goes.
        if (first + 1 < chunks.size) {
            val len = chunk.text.length
            val next = chunks[first + 1]
            for (span in chunk.text.getSpans(len, len, Any::class.java)) {
                if (chunk.text.getSpanStart(span) != len) continue
                val flags = chunk.text.getSpanFlags(span)
                chunk.text.removeSpan(span); chunk.removed(span)
                next.text.setSpan(span, 0, 0, flags); next.added(span)
                home[span] = next
            }
        }
        reindex()
        if (chunk.text.length > max) splitIfLarge(first)
        else if (chunk.text.length == 0 && chunks.size > 1) {
            // Fold an emptied chunk into a neighbour so lookups never land on it.
            if (first + 1 < chunks.size) merge(first, first + 1) else merge(first - 1, first)
        }
        for ((span, s0, e0) in dropped) if (rendererChange == null || span !is TfSpan) {
            for (w in spanWatchers.toTypedArray()) w.onSpanRemoved(this, span, s0, e0)
        }
        for (w in watchers) w.onTextChanged(this, st, before, after)
        for (w in watchers) w.afterTextChanged(this)
        return this
    }

    override fun replace(st: Int, en: Int, text: CharSequence): Editable = replace(st, en, text, 0, text.length)
    override fun clearSpans() { for (span in home.keys.toList()) removeSpan(span) }

    override fun setFilters(filters: Array<InputFilter>) { this.filters = filters.copyOf() }
    override fun getFilters(): Array<InputFilter> = filters

    override val length: Int get() = total

    private var lastChunk = 0

    override fun get(index: Int): Char {
        var i = lastChunk
        if (i >= chunks.size || index < offsets[i] || index >= offsets[i + 1]) {
            if (index < 0 || index >= total) throw IndexOutOfBoundsException("$index of $total")
            i = chunkAt(index)
            lastChunk = i
        }
        return chunks[i].text[index - offsets[i]]
    }

    override fun getChars(start: Int, end: Int, dest: CharArray, destoff: Int) {
        if (start == end) return
        var i = chunkAt(start)
        var at = start
        var out = destoff
        while (at < end) {
            val base = offsets[i]
            val stop = minOf(end, offsets[i + 1])
            chunks[i].text.getChars(at - base, stop - base, dest, out)
            out += stop - at
            at = stop
            i++
        }
    }

    override fun subSequence(startIndex: Int, endIndex: Int): CharSequence {
        val out = SpannableStringBuilder()
        if (startIndex == endIndex) return out
        val chars = CharArray(endIndex - startIndex)
        getChars(startIndex, endIndex, chars, 0)
        out.append(String(chars))
        for (span in getSpans(startIndex, endIndex, Any::class.java)) {
            // The renderer's styling is drawn from engine data, never read back
            // from a copy. Accessibility copies the whole text after every
            // change, and carrying ~20k spans into it one setSpan at a time
            // cost 80% of a keystroke on a 19k-line note.
            if (span is TextWatcher || span is SpanWatcher || span is TfSpan) continue
            val s = maxOf(startIndex, getSpanStart(span)) - startIndex
            val e = minOf(endIndex, getSpanEnd(span)) - startIndex
            out.setSpan(span, s, e, getSpanFlags(span))
        }
        return out
    }

    /** Test hook: how many chunks the text is split into. */
    val chunkCount: Int get() = chunks.size

    override fun toString(): String {
        val chars = CharArray(total)
        getChars(0, total, chars, 0)
        return String(chars)
    }

    companion object {
        /** Characters per chunk when splitting, and the size that triggers a split. */
        const val TARGET = 8_000
        const val MAX = 16_000

        /** Builds from [source], copying its spans (not watchers: the view attaches its own). */
        fun from(source: CharSequence, target: Int = TARGET, max: Int = MAX): ChunkedEditable {
            val editable = ChunkedEditable(target, max)
            val text = source.toString()
            val whole = EditableChunk(SpannableStringBuilder(text))
            editable.chunks.add(whole)
            editable.reindex()
            if (source is Spanned) {
                for (span in source.getSpans(0, source.length, Any::class.java)) {
                    if (span is TextWatcher || span is SpanWatcher) continue
                    whole.text.setSpan(span, source.getSpanStart(span), source.getSpanEnd(span), source.getSpanFlags(span))
                    whole.added(span)
                    editable.home[span] = whole
                }
            }
            editable.splitIfLarge(0)
            return editable
        }
    }
}

package com.futo.notes.textfirst

import uniffi.futo_notes_ffi.EditorAtomKind
import uniffi.futo_notes_ffi.EditorInlineFormat
import uniffi.futo_notes_ffi.EditorProjection

// The engine → view data: display edits, span descriptions and the toolbar's
// caret state, and the planner that turns an engine projection into spans.

/** One display edit for the view, in UTF-16 units of the text it applies to. */
internal class TextEdit(val start: Int, val end: Int, val text: String)

/** Span descriptions for one restyled window; the view turns them into [TfSpan]s. */
internal sealed class SpanSpec(val start: Int, val end: Int) {
    class Inline(start: Int, end: Int, val bold: Boolean, val italic: Boolean, val strike: Boolean, val code: Boolean) : SpanSpec(start, end)
    class Heading(start: Int, end: Int, val level: Int) : SpanSpec(start, end)
    class Quote(start: Int, end: Int, val depth: Int) : SpanSpec(start, end)
    class ListRow(start: Int, end: Int, val depth: Int, val marker: ListMarker, val number: Long?, val checked: Boolean, val first: Boolean) : SpanSpec(start, end)
    class Code(start: Int, end: Int) : SpanSpec(start, end)
    class Metadata(start: Int, end: Int) : SpanSpec(start, end)
    class Link(start: Int, end: Int, val destination: String) : SpanSpec(start, end)
    class Wikilink(start: Int, end: Int, val label: String, val noteId: String?) : SpanSpec(start, end)
    class Divider(start: Int, end: Int) : SpanSpec(start, end)
    class Image(start: Int, end: Int, val destination: String, val alt: String, val vault: Boolean, val remote: Boolean) : SpanSpec(start, end)
    class TableRow(start: Int, end: Int, val row: GridRow) : SpanSpec(start, end)
    class TableDelimiter(start: Int, end: Int) : SpanSpec(start, end)
}

internal class StyleWindow(val start: Int, val end: Int, val specs: List<SpanSpec>)

/**
 * Everything the view needs to catch up with one engine step, applied together
 * and once (host contract §2 "Revisions"). `seq` orders updates; the view
 * reports the last one it applied so a touch selection made against an older
 * display can be recognised and dropped.
 */
internal class UiUpdate(
    val seq: Int,
    val reset: String?,
    val edits: List<TextEdit>,
    val selStart: Int,
    val selEnd: Int,
    val composingStart: Int,
    val composingEnd: Int,
    val windows: List<StyleWindow>,
    /** Wall-clock start of the input that produced this update, for latency probes. */
    val inputUptimeNanos: Long,
    /** When the editor thread posted this update (elapsedRealtimeNanos). */
    val postedNanos: Long = 0L,
    /** When the engine call behind it returned; 0 when there was none. */
    val engineNanos: Long = 0L,
    /**
     * More of the note, inserted after what the view already shows (the tail of
     * a progressive open). Not a change of the note: it leaves the view's
     * selection and composition alone and does not mark the note edited.
     */
    val append: Boolean = false,
    /** Whether the view holds the whole note once this is applied (false while a progressive open is still streaming). */
    val complete: Boolean = true,
    /** Only styles change; preserve the newer native selection/composition and reader's anchor. */
    val styleOnly: Boolean = false,
    /** A source mutation may require a bounded reset rather than a visible text delta. */
    val sourceChanged: Boolean = false,
    val preserveScroll: Boolean = false,
)

/**
 * Where one key's time went, all in elapsedRealtimeNanos: the editor thread
 * took it from [input] to [posted], the engine call ending at [engine]; the UI thread picked it up at
 * [applyStart], had the text in by [editsEnd] and the spans by [applyEnd];
 * the next draw ran from [drawStart] to [drawEnd].
 */
internal class KeyTimings(
    val input: Long,
    val posted: Long,
    val engine: Long,
    val applyStart: Long,
    val editsEnd: Long,
    val applyEnd: Long,
    var drawStart: Long = 0L,
    var drawEnd: Long = 0L,
) {
    /** Processing stages, excluding the wait for the UI queue and refresh. */
    val workNanos: Long
        get() = (posted - input) + (applyEnd - applyStart) + (drawEnd - drawStart)
}

/** Toolbar-facing common state for the selection, or carried state at a collapsed caret. */
internal data class CaretState(
    val formats: Set<EditorInlineFormat>,
    val heading: Int,
    val quote: Boolean,
    val list: ListMarker?,
    val code: Boolean,
    val mixed: Boolean = false,
    val disabled: Set<String> = emptySet(),
) {
    companion object { val Empty = CaretState(emptySet(), 0, false, null, false) }
}

/** Projection → span descriptions in this display's UTF-16 units. No Markdown parsing. */
internal fun planSpans(p: EditorProjection, startUtf16: Int, outside: (Int) -> Int): List<SpanSpec> {
    val local = LocalOffsets(p.text, p.range.start.toInt(), startUtf16, outside)
    fun u(byte: ULong) = local.utf16(byte.toInt())
    // The block that a range ends on owns its line break, so a paragraph span
    // reaches the next line's start.
    val textEndUtf16 = startUtf16 + p.text.length
    fun withBreak(endUtf16: Int): Int {
        val localEnd = endUtf16 - startUtf16
        return if (localEnd < p.text.length && p.text[localEnd] == '\n') endUtf16 + 1 else endUtf16
    }
    val out = ArrayList<SpanSpec>(p.runs.size + p.blocks.size + p.atoms.size)
    val codeBodies = p.blocks.filter { it.code && it.range.start < it.range.end }.sortedBy { it.range.start }
    var previous: uniffi.futo_notes_ffi.EditorBlockDescription? = null
    for (b in p.blocks) {
        // Hidden fence rows can share the first/last body's display point.
        // They are not extra paragraphs with another code/quote margin.
        if (b.code && b.range.start == b.range.end) {
            val i = codeBodies.binarySearchBy(b.range.start) { it.range.start }.let { if (it >= 0) it else -it - 2 }
            if (i >= 0 && b.range.end <= codeBodies[i].range.end) continue
        }
        // An empty fence (opener, body and closer on one display point) arrives as that many
        // identical blocks; each would add its own quote margin and bar.
        if (b == previous) continue
        previous = b
        val s = u(b.range.start)
        val e = withBreak(u(b.range.end)).coerceAtMost(textEndUtf16)
        when {
            b.metadata -> out.add(SpanSpec.Metadata(s, e))
            b.code -> out.add(SpanSpec.Code(s, e))
            b.heading > 0u -> out.add(SpanSpec.Heading(s, e, b.heading.toInt()))
        }
        if (b.quoteDepth > 0u) out.add(SpanSpec.Quote(s, e, b.quoteDepth.toInt()))
        b.list?.let { list ->
            val marker = when {
                list.checked != null -> ListMarker.Task
                list.number != null -> ListMarker.Ordered
                else -> ListMarker.Bullet
            }
            // The engine counts list nesting from 1.
            out.add(SpanSpec.ListRow(s, e, (list.depth.toInt() - 1).coerceAtLeast(0), marker, list.number?.toLong(), list.checked == true, list.first))
        }
    }
    for (r in p.runs) {
        if (r.formats.isEmpty()) continue
        out.add(
            SpanSpec.Inline(
                u(r.range.start), u(r.range.end),
                bold = EditorInlineFormat.BOLD in r.formats,
                italic = EditorInlineFormat.ITALIC in r.formats,
                strike = EditorInlineFormat.STRIKE in r.formats,
                code = EditorInlineFormat.CODE in r.formats,
            ),
        )
    }
    for (l in p.links) out.add(SpanSpec.Link(u(l.range.start), u(l.range.end), l.destination))
    for (w in p.wikilinks) out.add(SpanSpec.Wikilink(u(w.range.start), u(w.range.end), w.label, w.noteId))
    for (a in p.atoms) {
        val s = u(a.range.start); val e = u(a.range.end)
        when (a.kind) {
            EditorAtomKind.DIVIDER -> out.add(SpanSpec.Divider(s, e))
            EditorAtomKind.IMAGE -> a.image?.let { out.add(SpanSpec.Image(s, e, it.destination, it.alt, it.vault, it.remote)) }
        }
    }
    return splitAtLines(out, p.text, startUtf16)
}

/**
 * Cut every span at line ends so none crosses a line (a piece keeps its
 * line's `\n`). The view's Editable relies on this to keep an edit's work
 * inside one chunk; drawing is unchanged, since each piece covers whole
 * characters of one line. A list row's marker stays on its first piece.
 */
internal fun splitAtLines(specs: List<SpanSpec>, text: String, startUtf16: Int): List<SpanSpec> {
    val out = ArrayList<SpanSpec>(specs.size)
    for (spec in specs) {
        val atom = spec is SpanSpec.Wikilink || spec is SpanSpec.Divider || spec is SpanSpec.Image
        if (atom || spec.end <= spec.start) { out.add(spec); continue }
        var s = spec.start
        var first = true
        while (s < spec.end) {
            val nl = text.indexOf('\n', s - startUtf16)
            val lineEnd = if (nl < 0) spec.end else minOf(spec.end, startUtf16 + nl + 1)
            if (first && lineEnd == spec.end) { out.add(spec); break }
            out.add(spec.slice(s, lineEnd, first))
            first = false
            s = lineEnd
        }
    }
    return out
}

private fun SpanSpec.slice(start: Int, end: Int, first: Boolean): SpanSpec = when (this) {
    is SpanSpec.Inline -> SpanSpec.Inline(start, end, bold, italic, strike, code)
    is SpanSpec.Heading -> SpanSpec.Heading(start, end, level)
    is SpanSpec.Quote -> SpanSpec.Quote(start, end, depth)
    is SpanSpec.ListRow -> SpanSpec.ListRow(start, end, depth, marker, number, checked, this.first && first)
    is SpanSpec.Code -> SpanSpec.Code(start, end)
    is SpanSpec.Metadata -> SpanSpec.Metadata(start, end)
    is SpanSpec.Link -> SpanSpec.Link(start, end, destination)
    // Atoms are one unit and never span lines; keep them whole.
    is SpanSpec.Wikilink, is SpanSpec.Divider, is SpanSpec.Image, is SpanSpec.TableRow, is SpanSpec.TableDelimiter -> this
}

package com.futo.notes.textfirst

import uniffi.futo_notes_ffi.EditorInlineFormat

// The engine → view data: display edits, span descriptions and the toolbar's
// caret state.

/** One display edit for the view, in UTF-16 units of the text it applies to. */
internal class TextEdit(val start: Int, val end: Int, val text: String)

/** What the engine reports about a whole fenced block, even where a window holds only part of it. */
internal data class CodeBlockFacts(val start: Int, val end: Int, val language: String?, val name: String?, val lineCount: Int)

/** One shown code line: its 1-based [number] in its block, its mark, whether it is the block's first and last, and its [block]. */
internal data class CodeLineFacts(val number: Int, val first: Boolean, val last: Boolean, val block: CodeBlockFacts)

/** Span descriptions for one restyled window; the view turns them into [TfSpan]s. */
internal sealed class SpanSpec(val start: Int, val end: Int) {
    class Inline(start: Int, end: Int, val bold: Boolean, val italic: Boolean, val strike: Boolean, val code: Boolean) : SpanSpec(start, end)
    class Heading(start: Int, end: Int, val level: Int) : SpanSpec(start, end)
    class Quote(start: Int, end: Int, val depth: Int) : SpanSpec(start, end)
    /** [label] is the item's marker as typed (`3)`, `09.`); only an ordered item draws it. */
    class ListRow(start: Int, end: Int, val depth: Int, val marker: ListMarker, val label: String, val checked: Boolean, val first: Boolean) : SpanSpec(start, end)
    /** An indented plain line under a list: it takes the list's display level and draws no marker. */
    class Indent(start: Int, end: Int, val depth: Int) : SpanSpec(start, end)
    class Code(start: Int, end: Int, val line: CodeLineFacts) : SpanSpec(start, end)
    class Metadata(start: Int, end: Int) : SpanSpec(start, end)
    class Link(start: Int, end: Int, val destination: String) : SpanSpec(start, end)
    class Wikilink(start: Int, end: Int, val label: String, val noteId: String?) : SpanSpec(start, end)
    class Tag(start: Int, end: Int) : SpanSpec(start, end)
    class Divider(start: Int, end: Int) : SpanSpec(start, end)
    class Image(start: Int, end: Int, val destination: String, val alt: String, val vault: Boolean, val remote: Boolean) : SpanSpec(start, end)
    class TableRow(start: Int, end: Int, val row: GridRow) : SpanSpec(start, end)
    /** [typed]: the person is typing this row (writes_delimiter_row), so it shows as muted text, not the hidden grid line. */
    class TableDelimiter(start: Int, end: Int, val typed: Boolean = false) : SpanSpec(start, end)
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
    /**
     * The inline formats the marked text will have once committed, over
     * [composingStart, composingEnd); null when this update leaves them as they are.
     */
    val marked: List<SpanSpec.Inline>? = null,
    /** The code block selected as one object; the selection equals it. */
    val selectedBlock: Pair<Int, Int>? = null,
    /** Made by a key or the keyboard at the caret (EditorEngine.input), not a command such as a checkbox toggle. */
    val keyed: Boolean = false,
    /** A block was made whose opening fence takes the next letters as its language: its language field opens. */
    val writesLanguage: Boolean = false,
    /** This update is a dropped block landing: how the view keeps its place (EditorEngineBlocks.kt). */
    val drop: DropHold? = null,
    /** The engine revision the view holds once this is applied: a drag lifted at another ends (BlockLift.kt). */
    val revision: ULong = 0u,
)

/**
 * How the view keeps its place when a dropped block lands. [KEEP] keeps the scroll; otherwise
 * the line holding display offset [offset] (as the move leaves the text) is put back with its
 * top [top] px below the view's top. Either way the caret the move carries is not revealed.
 */
internal class DropHold(val offset: Int, val top: Int) {
    companion object { val KEEP = DropHold(-1, 0) }
}

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

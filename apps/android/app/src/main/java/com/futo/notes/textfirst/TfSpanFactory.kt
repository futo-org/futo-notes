package com.futo.notes.textfirst

/** Builds the renderer span for a [SpanSpec], and tells whether an existing span already is it. */
internal class TfSpanFactory(private val style: TextFirstStyle, private val marks: FindMarks, private val contentWidth: () -> Int, private val wikilinkWidth: (TfWikilink) -> Int) {
    private val tableScroll = mutableMapOf<Int, TableScroll>()
    fun create(spec: SpanSpec): TfSpan = when (spec) {
        is SpanSpec.Inline -> TfInline(style, spec.bold, spec.italic, spec.strike, spec.code)
        is SpanSpec.Heading -> TfHeading(style, spec.level)
        is SpanSpec.Quote -> TfQuote(style, spec.depth)
        is SpanSpec.ListRow -> TfList(style, spec.depth, spec.marker, spec.label, spec.checked, spec.first)
        is SpanSpec.ListItemMarker -> TfListMarker(style, spec.depth, spec.marker, spec.label, spec.checked)
        is SpanSpec.Indent -> TfIndent(style, spec.depth)
        is SpanSpec.Code -> TfCodeBlock(style, spec.line)
        is SpanSpec.Metadata -> TfMetadata(style)
        is SpanSpec.Link -> TfLink(style, spec.destination)
        is SpanSpec.Wikilink -> TfWikilink(style, spec.label, spec.noteId) { wikilinkWidth(it) }
        is SpanSpec.Tag -> TfTag(style)
        is SpanSpec.Divider -> TfDivider(style) { contentWidth() }
        is SpanSpec.Image -> TfImage(style, spec.destination, spec.alt, spec.vault, spec.remote) { contentWidth() }
        is SpanSpec.TableRow -> TfTableRow(style, spec.row, spec.start, tableScroll.getOrPut(spec.row.tableStart) { TableScroll() }, marks, contentWidth)
        is SpanSpec.TableDelimiter -> if (spec.typed) TfTypedDelimiter(style) else TfTableDelimiter(style)
    }

    /** A kept span takes the facts it draws but does not lay out (a code line's number). */
    fun refresh(spec: SpanSpec, span: TfSpan) {
        if (spec is SpanSpec.Code && span is TfCodeBlock) span.line = spec.line
    }

    fun matches(spec: SpanSpec, span: TfSpan): Boolean = when (spec) {
        is SpanSpec.Inline -> span is TfInline && span.bold == spec.bold && span.italic == spec.italic && span.strike == spec.strike && span.code == spec.code
        is SpanSpec.Heading -> span is TfHeading && span.level == spec.level
        is SpanSpec.Quote -> span is TfQuote && span.depth == spec.depth
        is SpanSpec.ListRow -> span is TfList && span.sameAs(TfList(style, spec.depth, spec.marker, spec.label, spec.checked, spec.first))
        is SpanSpec.ListItemMarker -> span is TfListMarker && span.sameAs(TfListMarker(style, spec.depth, spec.marker, spec.label, spec.checked))
        is SpanSpec.Indent -> span is TfIndent && span.depth == spec.depth
        is SpanSpec.Code -> span is TfCodeBlock && span.sameMetrics(spec.line)
        is SpanSpec.Metadata -> span is TfMetadata
        is SpanSpec.Link -> span is TfLink && span.destination == spec.destination
        is SpanSpec.Wikilink -> span is TfWikilink && span.label == spec.label && span.noteId == spec.noteId
        is SpanSpec.Tag -> span is TfTag
        is SpanSpec.Divider -> span is TfDivider
        is SpanSpec.Image -> span is TfImage && span.destination == spec.destination &&
            span.alt == spec.alt && span.vault == spec.vault && span.remote == spec.remote
        is SpanSpec.TableRow -> span is TfTableRow && span.matches(spec.row, spec.start)
        is SpanSpec.TableDelimiter -> if (spec.typed) span is TfTypedDelimiter else span is TfTableDelimiter
    }
}

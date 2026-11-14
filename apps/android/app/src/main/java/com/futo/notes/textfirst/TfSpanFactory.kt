package com.futo.notes.textfirst

/** Builds the renderer span for a [SpanSpec], and tells whether an existing span already is it. */
internal class TfSpanFactory(private val style: TextFirstStyle, private val marks: FindMarks, private val contentWidth: () -> Int, private val wikilinkWidth: (TfWikilink) -> Int) {
    private val tableScroll = mutableMapOf<Int, TableScroll>()
    fun create(spec: SpanSpec): TfSpan = when (spec) {
        is SpanSpec.Inline -> TfInline(style, spec.bold, spec.italic, spec.strike, spec.code)
        is SpanSpec.Heading -> TfHeading(style, spec.level)
        is SpanSpec.Quote -> TfQuote(style, spec.depth)
        is SpanSpec.ListRow -> TfList(style, spec.depth, spec.marker, spec.label, spec.checked, spec.first)
        is SpanSpec.Indent -> TfIndent(style, spec.depth)
        is SpanSpec.Code -> TfCodeBlock(style)
        is SpanSpec.Metadata -> TfMetadata(style)
        is SpanSpec.Link -> TfLink(style, spec.destination)
        is SpanSpec.Wikilink -> TfWikilink(style, spec.label, spec.noteId) { wikilinkWidth(it) }
        is SpanSpec.Divider -> TfDivider(style) { contentWidth() }
        is SpanSpec.Image -> TfImage(style, spec.destination, spec.alt, spec.vault, spec.remote) { contentWidth() }
        is SpanSpec.TableRow -> TfTableRow(style, spec.row, spec.start, tableScroll.getOrPut(spec.row.tableStart) { TableScroll() }, marks, contentWidth)
        is SpanSpec.TableDelimiter -> TfTableDelimiter()
    }

    fun matches(spec: SpanSpec, span: TfSpan): Boolean = when (spec) {
        is SpanSpec.Inline -> span is TfInline && span.bold == spec.bold && span.italic == spec.italic && span.strike == spec.strike && span.code == spec.code
        is SpanSpec.Heading -> span is TfHeading && span.level == spec.level
        is SpanSpec.Quote -> span is TfQuote && span.depth == spec.depth
        is SpanSpec.ListRow -> span is TfList && span.sameAs(TfList(style, spec.depth, spec.marker, spec.label, spec.checked, spec.first))
        is SpanSpec.Indent -> span is TfIndent && span.depth == spec.depth
        is SpanSpec.Code -> span is TfCodeBlock
        is SpanSpec.Metadata -> span is TfMetadata
        is SpanSpec.Link -> span is TfLink && span.destination == spec.destination
        is SpanSpec.Wikilink -> span is TfWikilink && span.label == spec.label && span.noteId == spec.noteId
        is SpanSpec.Divider -> span is TfDivider
        is SpanSpec.Image -> span is TfImage && span.destination == spec.destination
        is SpanSpec.TableRow -> span is TfTableRow && span.matches(spec.row, spec.start)
        is SpanSpec.TableDelimiter -> span is TfTableDelimiter
    }
}

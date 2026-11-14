package com.futo.notes.textfirst

/** Test hook: every indexed span lives in a live chunk that holds it, and vice versa. */
internal fun ChunkedEditable.verifyIndex() {
    for ((span, chunk) in home) {
        check(chunks.any { it === chunk }) { "$span indexed to a dropped chunk" }
        check(chunk.text.getSpanStart(span) >= 0) { "$span indexed but not in its chunk" }
    }
    for (chunk in chunks) for (span in chunk.text.getSpans(0, chunk.text.length, Any::class.java)) {
        check(home[span] === chunk) { "$span in a chunk but indexed elsewhere" }
    }
}

/** Test hook: where a span lives. */
internal fun ChunkedEditable.describe(span: Any): String {
    val chunk = home[span] ?: return "unindexed"
    val i = indexOf(chunk)
    return "chunk $i/${chunks.size} offset ${offsets[i]} len ${chunk.text.length} local ${chunk.text.getSpanStart(span)}..${chunk.text.getSpanEnd(span)} offsets=${offsets.toList()}"
}

package com.futo.notes.ui.components

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle

/**
 * Render INLINE markdown (`**bold**`, `*italic*` / `_italic_`, `***both***`,
 * `~~strike~~`, `` `code` ``) into an [AnnotatedString], leaving every other
 * character — including newlines — verbatim.
 *
 * This is the Compose counterpart of the iOS note-list preview, which uses
 * `AttributedString(markdown:options: .inlineOnlyPreservingWhitespace)`: only
 * inline emphasis is interpreted, block structure is NOT (the block markdown was
 * already rewritten into ☐/☑/• glyphs and stripped headings by the shared Rust
 * `make_rich_preview`). Spans nest, an opener must be followed and a closer
 * preceded by non-whitespace, and `_` never opens or closes inside a word
 * (`snake_case_name` stays literal). A backslash before ASCII punctuation
 * makes it a literal character that never delimits. Deliberately small and
 * forgiving — an unmatched marker is emitted literally, never throws.
 */
fun parseInlinePreview(src: String, codeColor: Color): AnnotatedString = buildAnnotatedString {
    appendInline(src, 0, src.length, codeColor)
}

private fun AnnotatedString.Builder.appendInline(src: String, start: Int, end: Int, codeColor: Color) {
    var i = start
    while (i < end) {
        val c = src[i]
        val codeEnd = if (c == '`') codeSpanEnd(src, i, end) else -1
        when {
            isEscape(src, i, end) -> {
                append(src[i + 1]); i += 2
            }
            codeEnd >= 0 -> {
                withStyle(SpanStyle(fontFamily = FontFamily.Monospace, color = codeColor)) {
                    append(src, i + 1, codeEnd)
                }
                i = codeEnd + 1
            }
            c == '*' || c == '_' || c == '~' -> {
                val run = runLength(src, i, end)
                val close = emphasisCloser(src, i, run, end)
                if (close >= 0) {
                    withStyle(emphasisStyle(c, run)) { appendInline(src, i + run, close, codeColor) }
                    i = close + run
                } else {
                    append(c); i++
                }
            }
            else -> {
                append(c); i++
            }
        }
    }
}

private fun codeSpanEnd(src: String, open: Int, end: Int): Int {
    val close = src.indexOf('`', open + 1)
    return if (close > open + 1 && close < end) close else -1
}

private fun runLength(src: String, at: Int, end: Int): Int {
    var j = at
    while (j < end && src[j] == src[at]) j++
    return j - at
}

private fun emphasisCloser(src: String, open: Int, run: Int, end: Int, skipNested: Boolean = true): Int {
    val c = src[open]
    if (if (c == '~') run != 2 else run > 3) return -1
    if (open + run >= end || src[open + run].isWhitespace()) return -1
    if (c == '_' && src.getOrNull(open - 1)?.isLetterOrDigit() == true) return -1
    var j = open + run
    while (j < end) {
        val codeEnd = if (src[j] == '`') codeSpanEnd(src, j, end) else -1
        when {
            isEscape(src, j, end) -> j += 2
            codeEnd >= 0 -> j = codeEnd + 1
            src[j] == c -> {
                val closeRun = runLength(src, j, end)
                val closes = closeRun == run && !src[j - 1].isWhitespace() &&
                    (c != '_' || src.getOrNull(j + run)?.isLetterOrDigit() != true)
                if (closes) return j
                // ponytail: one nesting level keeps unclosed openers polynomial;
                // deeper same-marker nesting needs a CommonMark delimiter stack.
                val nestedClose = if (skipNested) emphasisCloser(src, j, closeRun, end, skipNested = false) else -1
                j = if (nestedClose >= 0) nestedClose + closeRun else j + closeRun
            }
            else -> j++
        }
    }
    return -1
}

private const val ASCII_PUNCTUATION = "!\"#\$%&'()*+,-./:;<=>?@[\\]^_`{|}~"

private fun isEscape(src: String, at: Int, end: Int): Boolean =
    src[at] == '\\' && at + 1 < end && src[at + 1] in ASCII_PUNCTUATION

private fun emphasisStyle(c: Char, run: Int): SpanStyle = when {
    c == '~' -> SpanStyle(textDecoration = TextDecoration.LineThrough)
    run == 1 -> SpanStyle(fontStyle = FontStyle.Italic)
    run == 2 -> SpanStyle(fontWeight = FontWeight.Bold)
    else -> SpanStyle(fontWeight = FontWeight.Bold, fontStyle = FontStyle.Italic)
}

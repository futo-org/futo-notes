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
 * Render INLINE markdown (`**bold**`, `*italic*` / `_italic_`, `~~strike~~`,
 * `` `code` ``) into an [AnnotatedString], leaving every other character —
 * including newlines — verbatim.
 *
 * This is the Compose counterpart of the iOS note-list preview, which uses
 * `AttributedString(markdown:options: .inlineOnlyPreservingWhitespace)`: only
 * inline emphasis is interpreted, block structure is NOT (the block markdown was
 * already rewritten into ☐/☑/• glyphs and stripped headings by the shared Rust
 * `make_rich_preview`). Deliberately small and forgiving — an unmatched marker
 * is emitted as a literal char, never throws.
 */
fun parseInlinePreview(src: String, codeColor: Color): AnnotatedString = buildAnnotatedString {
    var i = 0
    val n = src.length
    while (i < n) {
        val c = src[i]
        when {
            // `code`
            c == '`' -> {
                val end = src.indexOf('`', i + 1)
                if (end > i + 1) {
                    withStyle(SpanStyle(fontFamily = FontFamily.Monospace, color = codeColor)) {
                        append(src.substring(i + 1, end))
                    }
                    i = end + 1
                } else {
                    append(c); i++
                }
            }
            // **bold** (only when a non-space follows the opener, so "** " in
            // prose isn't swallowed).
            c == '*' && i + 1 < n && src[i + 1] == '*' && i + 2 < n && !src[i + 2].isWhitespace() -> {
                val end = src.indexOf("**", i + 2)
                if (end > i + 1) {
                    withStyle(SpanStyle(fontWeight = FontWeight.Bold)) {
                        append(src.substring(i + 2, end))
                    }
                    i = end + 2
                } else {
                    append(c); i++
                }
            }
            // ~~strikethrough~~
            c == '~' && i + 1 < n && src[i + 1] == '~' -> {
                val end = src.indexOf("~~", i + 2)
                if (end > i + 1) {
                    withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) {
                        append(src.substring(i + 2, end))
                    }
                    i = end + 2
                } else {
                    append(c); i++
                }
            }
            // *italic* or _italic_ (only when a non-space follows the opener, so
            // a lone "*" in prose like "2 * 3" stays literal).
            (c == '*' || c == '_') && i + 1 < n && !src[i + 1].isWhitespace() -> {
                val end = src.indexOf(c, i + 1)
                if (end > i + 1) {
                    withStyle(SpanStyle(fontStyle = FontStyle.Italic)) {
                        append(src.substring(i + 1, end))
                    }
                    i = end + 1
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

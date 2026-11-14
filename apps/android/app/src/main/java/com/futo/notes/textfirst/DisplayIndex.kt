package com.futo.notes.textfirst

/**
 * UTF-16 ⇄ UTF-8 offset map over the displayed text (walkthrough item 3: "an
 * indexed display encoding map may convert coordinates, but contains no
 * Markdown rules"). The engine speaks display UTF-8 bytes; Android speaks
 * UTF-16 units. Lines are the unit of bookkeeping: two Fenwick trees hold each
 * line's length in both encodings (the line's `\n` included), so a conversion
 * is a log-time line lookup plus a scan of one line, and an all-ASCII line is
 * plain arithmetic.
 *
 * The caller owns the text and passes the current version to every call.
 */
internal class DisplayIndex(text: CharSequence) {
    private var count = 0
    private var u16 = IntArray(0)
    private var u8 = IntArray(0)
    private var fen16 = IntArray(1)
    private var fen8 = IntArray(1)

    init {
        rebuildFrom(splitLines(text, 0, text.length, finalLine = true))
    }

    val lineCount: Int get() = count
    val utf16Length: Int get() = prefix(fen16, count)
    val utf8Length: Int get() = prefix(fen8, count)

    fun utf16ToByte(text: CharSequence, offset: Int): Int {
        require(offset in 0..utf16Length) { "utf16 offset $offset outside 0..$utf16Length" }
        val line = lineOf(fen16, offset)
        val start16 = prefix(fen16, line)
        val start8 = prefix(fen8, line)
        if (u16[line] == u8[line]) return start8 + (offset - start16)
        return start8 + utf8Length(text, start16, offset)
    }

    fun byteToUtf16(text: CharSequence, byte: Int): Int {
        require(byte in 0..utf8Length) { "byte offset $byte outside 0..$utf8Length" }
        val line = lineOf(fen8, byte)
        val start16 = prefix(fen16, line)
        val start8 = prefix(fen8, line)
        if (u16[line] == u8[line]) return start16 + (byte - start8)
        var i = start16
        var b = start8
        while (b < byte) {
            val c = text[i]
            if (Character.isHighSurrogate(c) && i + 1 < text.length && Character.isLowSurrogate(text[i + 1])) {
                b += 4; i += 2
            } else {
                b += utf8Width(c); i += 1
            }
        }
        check(b == byte) { "byte offset $byte splits a character" }
        return i
    }

    /**
     * Record that `text` (already updated) had `[start, oldEnd)` replaced by
     * `insertedLength` UTF-16 units. Only the touched lines are re-measured;
     * the trees are rebuilt only when the line count changes.
     */
    fun replace(text: CharSequence, start: Int, oldEnd: Int, insertedLength: Int) {
        val first = lineOf(fen16, start)
        val last = lineOf(fen16, oldEnd)
        val regionStart = prefix(fen16, first)
        val oldRegionEnd = prefix(fen16, last + 1)
        val regionEnd = oldRegionEnd + insertedLength - (oldEnd - start)
        val lines = splitLines(text, regionStart, regionEnd, finalLine = last == count - 1)
        val replaced = last - first + 1
        if (lines.size == replaced) {
            for (k in lines.indices) {
                val line = first + k
                val (n16, n8) = lines[k]
                add(fen16, line, n16 - u16[line]); u16[line] = n16
                add(fen8, line, n8 - u8[line]); u8[line] = n8
            }
            return
        }
        // The line count changed: splice the lengths (no per-line objects; an
        // Enter in a 19k-line note boxed every line) and rebuild the trees.
        val tail = count - (last + 1)
        val total = first + lines.size + tail
        val n16 = IntArray(total)
        val n8 = IntArray(total)
        System.arraycopy(u16, 0, n16, 0, first)
        System.arraycopy(u8, 0, n8, 0, first)
        for (k in lines.indices) { n16[first + k] = lines[k].first; n8[first + k] = lines[k].second }
        System.arraycopy(u16, last + 1, n16, first + lines.size, tail)
        System.arraycopy(u8, last + 1, n8, first + lines.size, tail)
        count = total
        u16 = n16
        u8 = n8
        fen16 = build(u16)
        fen8 = build(u8)
    }

    private fun rebuildFrom(lines: List<Pair<Int, Int>>) {
        count = lines.size
        u16 = IntArray(count) { lines[it].first }
        u8 = IntArray(count) { lines[it].second }
        fen16 = build(u16)
        fen8 = build(u8)
    }

    /** Lines of `[from, to)`, each including its `\n`; [finalLine] keeps the unterminated tail. */
    private fun splitLines(text: CharSequence, from: Int, to: Int, finalLine: Boolean): List<Pair<Int, Int>> {
        val out = ArrayList<Pair<Int, Int>>()
        var lineStart = from
        var bytes = 0
        var i = from
        while (i < to) {
            val c = text[i]
            if (c == '\n') {
                out.add((i + 1 - lineStart) to (bytes + 1))
                lineStart = i + 1; bytes = 0; i += 1
            } else if (Character.isHighSurrogate(c) && i + 1 < to && Character.isLowSurrogate(text[i + 1])) {
                bytes += 4; i += 2
            } else {
                bytes += utf8Width(c); i += 1
            }
        }
        if (finalLine) out.add((to - lineStart) to bytes)
        else check(lineStart == to) { "line index region ended mid-line" }
        return out
    }

    private fun lineOf(tree: IntArray, offset: Int): Int {
        // Largest line whose start is <= offset; an offset at the very end
        // belongs to the last line.
        var pos = 0
        var remaining = offset
        var step = Integer.highestOneBit(maxOf(count, 1))
        while (step > 0) {
            val next = pos + step
            if (next <= count && tree[next] <= remaining) {
                pos = next
                remaining -= tree[next]
            }
            step = step shr 1
        }
        return minOf(pos, count - 1)
    }

    private fun prefix(tree: IntArray, lines: Int): Int {
        var sum = 0
        var i = lines
        while (i > 0) { sum += tree[i]; i -= i and -i }
        return sum
    }

    private fun add(tree: IntArray, line: Int, delta: Int) {
        if (delta == 0) return
        var i = line + 1
        while (i <= count) { tree[i] += delta; i += i and -i }
    }

    private fun build(values: IntArray): IntArray {
        val tree = IntArray(values.size + 1)
        for (i in values.indices) {
            tree[i + 1] += values[i]
            val parent = (i + 1) + ((i + 1) and -(i + 1))
            if (parent <= values.size) tree[parent] += tree[i + 1]
        }
        return tree
    }

    companion object {
        fun utf8Width(c: Char): Int = when {
            c.code < 0x80 -> 1
            c.code < 0x800 -> 2
            else -> 3
        }

        fun utf8Length(text: CharSequence, from: Int, to: Int): Int {
            var bytes = 0
            var i = from
            while (i < to) {
                val c = text[i]
                if (Character.isHighSurrogate(c) && i + 1 < to && Character.isLowSurrogate(text[i + 1])) {
                    bytes += 4; i += 2
                } else {
                    bytes += utf8Width(c); i += 1
                }
            }
            return bytes
        }
    }
}

/** Byte → UTF-16 within one projection's text, which starts at a known offset. */
internal class LocalOffsets(
    private val text: String,
    private val startByte: Int,
    private val startUtf16: Int,
    /** Converts an offset outside this text: a block may extend past its projection's window. */
    private val outside: (Int) -> Int = { error("byte $it outside the projection") },
) {
    private val ascii = text.length == DisplayIndex.utf8Length(text, 0, text.length)
    private val endByte = startByte + if (ascii) text.length else DisplayIndex.utf8Length(text, 0, text.length)
    private var cursorByte = 0
    private var cursorChar = 0

    fun utf16(byte: Int): Int {
        if (byte < startByte || byte > endByte) return outside(byte)
        val local = byte - startByte
        if (ascii) return startUtf16 + local
        if (local < cursorByte) { cursorByte = 0; cursorChar = 0 }
        while (cursorByte < local) {
            val c = text[cursorChar]
            if (Character.isHighSurrogate(c) && cursorChar + 1 < text.length && Character.isLowSurrogate(text[cursorChar + 1])) {
                cursorByte += 4; cursorChar += 2
            } else {
                cursorByte += DisplayIndex.utf8Width(c); cursorChar += 1
            }
        }
        return startUtf16 + cursorChar
    }
}

package com.futo.notes.textfirst

import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class DisplayIndexTest {
    private fun bytesBefore(text: String, utf16: Int) = text.substring(0, utf16).toByteArray(Charsets.UTF_8).size

    private fun assertMatches(text: StringBuilder, index: DisplayIndex) {
        val s = text.toString()
        assertEquals(s.length, index.utf16Length)
        assertEquals(s.toByteArray(Charsets.UTF_8).size, index.utf8Length)
        assertEquals(s.count { it == '\n' } + 1, index.lineCount)
        var i = 0
        while (i <= s.length) {
            val bytes = bytesBefore(s, i)
            assertEquals("utf16 $i of ${s.length}", bytes, index.utf16ToByte(text, i))
            assertEquals("byte $bytes", i, index.byteToUtf16(text, bytes))
            i += if (i < s.length && Character.isHighSurrogate(s[i])) 2 else 1
        }
    }

    @Test
    fun convertsMixedWidthText() {
        val text = StringBuilder("a😀b\né&\n\nlast ü")
        assertMatches(text, DisplayIndex(text))
    }

    @Test
    fun rejectsAByteOffsetInsideACharacter() {
        val text = StringBuilder("é")
        assertThrows(IllegalStateException::class.java) { DisplayIndex(text).byteToUtf16(text, 1) }
    }

    @Test
    fun randomEditsKeepTheIndexExact() {
        val alphabet = listOf("a", "b", " ", "\n", "\n\n", "é", "😀", "中", "\r\n", "xyz")
        val random = Random(283)
        repeat(40) {
            val text = StringBuilder()
            repeat(random.nextInt(0, 30)) { text.append(alphabet.random(random)) }
            val index = DisplayIndex(text)
            repeat(60) {
                val cuts = (0..text.length).filter { it == text.length || it == 0 || !Character.isLowSurrogate(text[it]) }
                val a = cuts.random(random)
                val b = cuts.filter { it >= a }.random(random)
                val inserted = buildString { repeat(random.nextInt(0, 4)) { append(alphabet.random(random)) } }
                text.replace(a, b, inserted)
                index.replace(text, a, b, inserted.length)
                assertMatches(text, index)
            }
        }
    }

    @Test
    fun localOffsetsWalkProjectionText() {
        val text = "é😀x"
        val local = LocalOffsets(text, startByte = 10, startUtf16 = 4)
        assertEquals(4, local.utf16(10))
        assertEquals(5, local.utf16(12))
        assertEquals(7, local.utf16(16))
        assertEquals(8, local.utf16(17))
        assertEquals(5, local.utf16(12))
    }
}

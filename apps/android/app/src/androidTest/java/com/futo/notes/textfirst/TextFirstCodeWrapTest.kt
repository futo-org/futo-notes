package com.futo.notes.textfirst

import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/** Area 18 verifier: a wrapped first code line keeps its second row inside its own line, as later lines do. */
class TextFirstCodeWrapTest {
    private val long = "with some text in it and then a good deal more so it wraps"

    @Test fun aWrappedFirstCodeLineRowsAreSpacedAsALaterOnes() = textFirstSession("intro\n\n```txt\none $long\ntwo $long\nthree\n```\n\nend") { c ->
        val view = c.view
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        delay(300)
        val l = view.layout
        val text = view.editableText
        fun rows(word: String): List<String> {
            val first = l.getLineForOffset(text.indexOf(word))
            val next = l.getLineForOffset(text.indexOf("\n", text.indexOf(word)) + 1)
            return (first until next).map { "top=${l.getLineTop(it)} base=${l.getLineBaseline(it)} bottom=${l.getLineBottom(it)}" }
        }
        val one = rows("one ")
        val two = rows("two ")
        fun pitch(word: String): List<Int> {
            val first = l.getLineForOffset(text.indexOf(word))
            val next = l.getLineForOffset(text.indexOf("\n", text.indexOf(word)) + 1)
            return (first + 1 until next).map { l.getLineBaseline(it) - l.getLineBaseline(it - 1) } +
                (l.getLineBottom(next - 1) - l.getLineBaseline(next - 1))
        }
        assertEquals("one=$one two=$two", pitch("two "), pitch("one "))
    }
}

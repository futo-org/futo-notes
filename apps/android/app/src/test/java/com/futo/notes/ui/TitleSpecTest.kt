package com.futo.notes.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class TitleSpecTest {
    @Test
    fun `live title filter strips the full shared control range`() {
        assertEquals(
            "abcde",
            TitleSpec.forbiddenChars.replace("a\u0000b\u007Fc\u0085d\u009Fe", ""),
        )
    }
}

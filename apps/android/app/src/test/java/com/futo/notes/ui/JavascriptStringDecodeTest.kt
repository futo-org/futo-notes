package com.futo.notes.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class JavascriptStringDecodeTest {
    @Test
    fun `javascript results decode escaped strings exactly`() {
        assertEquals(
            "line one\n\"quoted\"",
            decodeJavascriptString("\"line one\\n\\\"quoted\\\"\""),
        )
    }

    @Test
    fun `missing javascript result decodes as absence`() {
        assertNull(decodeJavascriptString(null))
        assertNull(decodeJavascriptString("null"))
    }
}

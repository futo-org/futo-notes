package com.futo.notes.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class EditorMigrationCaptureTest {
    @Test
    fun `javascript content snapshots decode escaped markdown exactly`() {
        assertEquals(
            "line one\n\"quoted\"",
            decodeJavascriptString("\"line one\\n\\\"quoted\\\"\""),
        )
    }

    @Test
    fun `missing javascript result aborts capture`() {
        assertNull(decodeJavascriptString(null))
        assertNull(decodeJavascriptString("null"))
    }
}

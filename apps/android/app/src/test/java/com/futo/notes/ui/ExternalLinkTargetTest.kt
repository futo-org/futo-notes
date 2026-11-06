package com.futo.notes.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ExternalLinkTargetTest {
    @Test
    fun `a web mail or phone link opens as written`() {
        for (url in listOf("https://futo.org", "HTTP://example.com/a?b=c", "mailto:a@b.co", "tel:+15555550100")) {
            assertEquals(url, externalLinkTarget(url))
        }
    }

    @Test
    fun `a destination with no scheme that names a host opens over https`() {
        assertEquals("https://futo.org", externalLinkTarget("futo.org"))
        assertEquals("https://www.example.org/a/b?c=d#e", externalLinkTarget("www.example.org/a/b?c=d#e"))
        assertEquals("https://sub.example.co.uk:8080/x", externalLinkTarget("sub.example.co.uk:8080/x"))
    }

    @Test
    fun `any other scheme or a destination that is not a host never opens`() {
        for (url in listOf(
            "javascript:alert(1)", "file:///etc/passwd", "ftp://x.y", "futo-asset://a",
            "other.md", "notes/other", "#heading", "./a.b", "two words.com", "", "localhost",
        )) {
            assertNull(url, externalLinkTarget(url))
        }
    }
}

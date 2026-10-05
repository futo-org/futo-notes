package com.futo.notes

import com.futo.notes.ui.isInAppEditorNavigation
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EditorLinkNavigationTest {
    @Test
    fun schemeRoutingMatchesWhatTheEditorCanLoadInPlace() {
        // Only the local editor bundle loads in place, whatever its case.
        listOf("file", "FILE").forEach { scheme ->
            assertTrue(scheme, isInAppEditorNavigation(scheme))
        }
        // Everything else, web or not, is handed off to the system.
        listOf("http", "https", "HTTPS", "mailto", "tel", null).forEach { scheme ->
            assertFalse("$scheme", isInAppEditorNavigation(scheme))
        }
    }
}

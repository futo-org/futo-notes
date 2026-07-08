package com.futo.notes

import com.futo.notes.ui.isInAppEditorNavigation
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EditorLinkNavigationTest {
    @Test
    fun httpLinkIsHandedOffNotLoadedInEditor() {
        assertFalse(isInAppEditorNavigation("http"))
        assertFalse(isInAppEditorNavigation("https"))
    }

    @Test
    fun nonWebSchemesAreAlsoHandedOff() {
        assertFalse(isInAppEditorNavigation("mailto"))
        assertFalse(isInAppEditorNavigation("tel"))
        assertFalse(isInAppEditorNavigation(null))
    }

    @Test
    fun localEditorBundleLoadsInPlace() {
        assertTrue(isInAppEditorNavigation("file"))
    }

    @Test
    fun schemeMatchIsCaseInsensitive() {
        assertTrue(isInAppEditorNavigation("FILE"))
        assertFalse(isInAppEditorNavigation("HTTPS"))
    }
}

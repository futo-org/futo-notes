package com.futo.notes

import com.futo.notes.ui.MIN_SUPPORTED_WEBVIEW_MAJOR
import com.futo.notes.ui.isSupportedWebViewVersion
import com.futo.notes.ui.parseChromiumMajor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Guards the System WebView support gate (github#8): the editor bundle can't run
 * below Chromium [MIN_SUPPORTED_WEBVIEW_MAJOR], so the shell must show the
 * "update WebView" notice there — and must NOT hide a working editor when the
 * version can't be read.
 */
class LegacyWebViewNoticeTest {
    @Test
    fun parsesChromiumMajorFromVersionName() {
        assertEquals(83, parseChromiumMajor("83.0.4103.106"))
        assertEquals(66, parseChromiumMajor("66.0.3359.158"))
        assertEquals(120, parseChromiumMajor("120.0.6099.230"))
    }

    @Test
    fun returnsNullForMissingOrUnparseableVersion() {
        assertNull(parseChromiumMajor(null))
        assertNull(parseChromiumMajor(""))
        assertNull(parseChromiumMajor("dev"))
    }

    @Test
    fun versionsAtOrAboveFloorAreSupported() {
        assertTrue(isSupportedWebViewVersion("$MIN_SUPPORTED_WEBVIEW_MAJOR.0.0.0"))
        assertTrue(isSupportedWebViewVersion("85.0.4183.127"))
        assertTrue(isSupportedWebViewVersion("120.0.6099.230"))
    }

    @Test
    fun versionsBelowFloorAreUnsupported() {
        assertFalse(isSupportedWebViewVersion("66.0.3359.158"))
        assertFalse(isSupportedWebViewVersion("79.0.3945.116"))
    }

    @Test
    fun unknownVersionIsTreatedAsSupported() {
        assertTrue(isSupportedWebViewVersion(null))
        assertTrue(isSupportedWebViewVersion("garbage"))
    }
}

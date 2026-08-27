package com.futo.notes.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Guards the editor-engine gate: it must decide from the boot outcome and never
 * from a version number (the Huawei regression is recorded in
 * apps/android/AGENTS.md; github#8 is the blank-pane bug it replaced). A vendor
 * `versionName` cannot reach the decision at all now, and these tests hold that
 * shape — a booted bundle is supported, and only the page's own verdict (or a
 * boot that never happened) makes it unsupported.
 */
class EditorEngineSupportTest {
    @Test
    fun `a booted bundle has no failure`() {
        assertNull(editorEngineFailure("booted", isFinal = false))
        assertNull(editorEngineFailure("booted", isFinal = true))
    }

    /**
     * The gate's "supported" signal. It has to be the MOUNT, not the bridge
     * `initialized` handshake that follows it (EditorWebView's `engineBooted`):
     * an engine that mounted the bundle runs the editor even if the config
     * round-trip is broken, and must never earn the notice.
     */
    @Test
    fun `only a mounted bundle counts as booted`() {
        assertTrue(editorEngineBooted("booted"))
        assertFalse(editorEngineBooted("pending"))
        assertFalse(editorEngineBooted("unsupported:ES2020 syntax"))
        // An unreadable probe decides nothing in either direction.
        assertFalse(editorEngineBooted(null))
    }

    @Test
    fun `the preflight verdict is the failure reason`() {
        assertEquals(
            "ES2020 syntax (optional chaining / nullish coalescing)",
            editorEngineFailure(
                "unsupported:ES2020 syntax (optional chaining / nullish coalescing)",
                isFinal = false,
            ),
        )
        // A verdict with no detail still counts as a failure.
        assertEquals(
            "engine below the bundle's syntax floor",
            editorEngineFailure("unsupported:", isFinal = true),
        )
    }

    @Test
    fun `a still-booting page is undecided until the grace period ends`() {
        assertNull(editorEngineFailure("pending", isFinal = false))
        // Past the grace period a page with no FutoEditor never ran the bundle,
        // which is the blank editor pane the notice exists to replace.
        assertEquals("bundle never mounted", editorEngineFailure("pending", isFinal = true))
    }

    @Test
    fun `a failed probe never hides a working editor`() {
        assertNull(editorEngineFailure(null, isFinal = false))
        assertNull(editorEngineFailure(null, isFinal = true))
    }

    @Test
    fun `the pane is unavailable on a failure or with no WebView provider`() {
        assertFalse(isEditorPaneUnavailable(hasWebViewProvider = true, engineFailure = null))
        assertTrue(
            isEditorPaneUnavailable(hasWebViewProvider = true, engineFailure = "bundle never mounted"),
        )
        assertTrue(isEditorPaneUnavailable(hasWebViewProvider = false, engineFailure = null))
    }

    @Test
    fun `chromium major comes from the user agent, across providers`() {
        // Google's WebView, a reduced-UA WebView, and a Huawei device's WebView:
        // every Chromium-based provider reports its engine as Chrome/<major>.
        assertEquals(
            120,
            parseChromiumMajorFromUserAgent(
                "Mozilla/5.0 (Linux; Android 13; Pixel 7; wv) AppleWebKit/537.36 " +
                    "(KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36",
            ),
        )
        assertEquals(
            125,
            parseChromiumMajorFromUserAgent(
                "Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 " +
                    "(KHTML, like Gecko) Version/4.0 Chrome/125.0.0.0 Mobile Safari/537.36",
            ),
        )
        assertEquals(
            94,
            parseChromiumMajorFromUserAgent(
                "Mozilla/5.0 (Linux; Android 10; POT-LX1; HMSCore 6.14.0; wv) " +
                    "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 " +
                    "Chrome/94.0.4606.85 Mobile Safari/537.36",
            ),
        )
    }

    @Test
    fun `an unreadable user agent yields no version, not a wrong one`() {
        assertNull(parseChromiumMajorFromUserAgent(null))
        assertNull(parseChromiumMajorFromUserAgent(""))
        // A vendor versionName is not a Chromium version — and not a UA either,
        // so nothing is read out of one.
        assertNull(parseChromiumMajorFromUserAgent("12.1.2.326"))
    }

    @Test
    fun `the notice names the floor, the engine, and the provider`() {
        val message = editorEngineNoticeMessage(
            chromiumMajor = 66,
            providerName = "com.google.android.webview",
            providerVersion = "66.0.3359.158",
        )
        assertEquals("editor.android.legacyWebView.body", message.path)
        assertEquals(EDITOR_CHROMIUM_FLOOR_MAJOR, message.arguments["minimumVersion"])
        assertEquals(66, message.arguments["currentVersion"])
        assertEquals("com.google.android.webview 66.0.3359.158", message.arguments["provider"])
    }

    /**
     * The probe and the preflight name the same global in two languages with
     * nothing linking them at build time (scripts/drift-registry.json →
     * `editor-engine-unsupported-global`), so rename one and the gate silently
     * degrades to the grace-period path with every other suite still green.
     * A SOURCE-SCAN, like [com.futo.notes.BridgeCoverageTest]: it proves the two
     * spellings agree, not that the verdict is produced.
     */
    @Test
    fun `the probe reads the global editor html publishes`() {
        val globals = Regex("""window\.(__futo\w+)""")
            .findAll(ENGINE_PROBE_JS)
            .map { it.groupValues[1] }
            .toSet()
        assertEquals(setOf("__futoEngineUnsupported"), globals)

        val editorHtml = listOf("editor.html", "../../editor.html", "../../../editor.html")
            .map(::File)
            .firstOrNull { it.exists() }
            ?: throw AssertionError("could not locate editor.html from cwd=${File(".").absolutePath}")
        val source = editorHtml.readText()
        for (global in globals) {
            assertTrue(
                "${editorHtml.path} never assigns window.$global — the preflight and " +
                    "ENGINE_PROBE_JS have drifted",
                source.contains("window.$global ="),
            )
        }
    }

    @Test
    fun `the notice omits what it could not read`() {
        val message = editorEngineNoticeMessage(
            chromiumMajor = null,
            providerName = null,
            providerVersion = null,
        )
        assertEquals("editor.android.legacyWebView.bodyGeneric", message.path)
        assertEquals(EDITOR_CHROMIUM_FLOOR_MAJOR, message.arguments["minimumVersion"])
        assertFalse(message.arguments.containsKey("currentVersion"))
        assertFalse(message.arguments.containsKey("provider"))
    }
}

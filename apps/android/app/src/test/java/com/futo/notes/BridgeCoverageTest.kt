package com.futo.notes

import com.futo.notes.ui.BridgeSpec
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Bridge message coverage (architecture-hardening.md F11 / PKT-7 gate 4).
 *
 * This is a SOURCE-SCAN, not a real interpreter: it asserts every outbound
 * message type bridge.ts can produce (BridgeSpec.OUTBOUND_MESSAGE_TYPES,
 * generated from packages/editor/src/bridge.ts by gen-bridge-spec.ts) either
 * has a `"type" ->` handler case in EditorWebView.kt's `handle()`, or is in
 * [EXEMPT] with a reason. It proves textual coverage, not runtime behavior —
 * it cannot catch a handler whose body silently no-ops.
 */
class BridgeCoverageTest {
    companion object {
        /** Message types EditorWebView.kt intentionally does not handle. */
        private val EXEMPT = mapOf(
            // bridge.ts:199-202 — Android's Chromium WebView normally exposes
            // the pasted image as a File and uses saveImageData instead; this
            // fallback exists only for WebViews (iOS WKWebView) that hide the
            // bitmap from the JS paste event.
            "pasteClipboardImage" to "Android never receives it by design (bridge.ts:199-202)",
        )
    }

    private fun editorWebViewSource(): String {
        val candidates = listOf(
            File("src/main/java/com/futo/notes/ui/EditorWebView.kt"),
            File("app/src/main/java/com/futo/notes/ui/EditorWebView.kt"),
            File("apps/android/app/src/main/java/com/futo/notes/ui/EditorWebView.kt"),
        )
        val found = candidates.firstOrNull { it.exists() }
            ?: throw AssertionError(
                "could not locate EditorWebView.kt from cwd=${File(".").absolutePath} — tried: " +
                    candidates.joinToString { it.path },
            )
        return found.readText()
    }

    @Test
    fun everyOutboundMessageTypeIsHandledOrExempt() {
        val source = editorWebViewSource()
        val missing = BridgeSpec.OUTBOUND_MESSAGE_TYPES.filter { type ->
            type !in EXEMPT && !source.contains("\"$type\" ->")
        }
        assertTrue(
            "EditorWebView.kt has no handler for: ${missing.joinToString()} — add a case in " +
                "handle(), or add it to BridgeCoverageTest.EXEMPT with a reason.",
            missing.isEmpty(),
        )
    }

    @Test
    fun exemptEntriesAreStillPartOfTheContract() {
        // A stale exemption (message type removed from bridge.ts) should be
        // deleted from EXEMPT, not silently kept around.
        val specTypes = BridgeSpec.OUTBOUND_MESSAGE_TYPES.toSet()
        val stale = EXEMPT.keys.filterNot { it in specTypes }
        assertTrue(
            "Stale BridgeCoverageTest.EXEMPT entries (no longer in BridgeSpec): $stale",
            stale.isEmpty(),
        )
    }
}

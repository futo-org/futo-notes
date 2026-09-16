package com.futo.notes

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Locks Kotlin's two session-precedence decisions to the shared cross-shell
 * case-set the Swift copies are checked against
 * (`tests/conformance/sync-session-mode.json`). Both shells must answer these
 * the same way, or a device behaves differently on iOS and Android for the same
 * saved secrets — which is exactly what `docs/spec/sync.md` specifies once.
 *
 * Read in place rather than copied, the same arrangement `SyncManagerDefaultsTest`
 * uses for the server-URL fixture. The case counts are asserted first so a
 * missing or truncated fixture fails loudly instead of passing on zero cases.
 */
class SyncSessionModeConformanceTest {

    private fun fixture(): JSONObject =
        JSONObject(File("../../../tests/conformance/sync-session-mode.json").readText())
            .getJSONObject("ops")

    @Test
    fun `hosted connect entry matches the shared fixture`() {
        val cases = fixture().getJSONObject("hostedConnectEntry").getJSONArray("cases")
        assertEquals("shared fixture case count", 8, cases.length())

        for (index in 0 until cases.length()) {
            val testCase = cases.getJSONObject(index)
            val mode = when (if (testCase.isNull("mode")) null else testCase.getString("mode")) {
                "hosted" -> SyncManager.SessionMode.HOSTED
                "selfHosted" -> SyncManager.SessionMode.SELF_HOSTED
                else -> null
            }
            val actual = SyncManager.hostedConnectEntry(
                testCase.getBoolean("connected"),
                testCase.getBoolean("hasClient"),
                testCase.getBoolean("healing"),
                mode,
            )
            assertEquals(
                testCase.getString("name"),
                testCase.getString("expected"),
                actual.fixtureName(),
            )
        }
    }

    @Test
    fun `restore branch matches the shared fixture`() {
        val cases = fixture().getJSONObject("restoreBranch").getJSONArray("cases")
        assertEquals("shared fixture case count", 4, cases.length())

        for (index in 0 until cases.length()) {
            val testCase = cases.getJSONObject(index)
            val actual = SyncManager.restoreBranch(
                testCase.getBoolean("hasStoredPassword"),
                testCase.getBoolean("hasHostedVault"),
            )
            assertEquals(
                testCase.getString("name"),
                testCase.getString("expected"),
                actual.fixtureName(),
            )
        }
    }

    /** The fixture spells the answers in the shared vocabulary, not Kotlin's. */
    private fun SyncManager.HostedConnectEntry.fixtureName(): String = when (this) {
        SyncManager.HostedConnectEntry.SKIP -> "skip"
        SyncManager.HostedConnectEntry.REPLACE_SELF_HOSTED -> "replaceSelfHosted"
        SyncManager.HostedConnectEntry.PROCEED -> "proceed"
    }

    private fun SyncManager.RestoreBranch.fixtureName(): String = when (this) {
        SyncManager.RestoreBranch.HOSTED -> "hosted"
        SyncManager.RestoreBranch.SELF_HOSTED -> "selfHosted"
        SyncManager.RestoreBranch.NOTHING -> "nothing"
    }
}

package com.futo.notes

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Regression guard for the user decision: the SYNC server URL seed default
 * must be the emulator dev server in DEBUG builds and EMPTY in RELEASE builds
 * (a shipping build starts with no server until the user enters one).
 *
 * Exercises the pure boolean-driven selector so neither branch depends on the
 * generated BuildConfig.DEBUG; the production wiring (`defaultServer()`) feeds
 * the real BuildConfig.DEBUG into this same function.
 */
class SyncManagerDefaultsTest {
    @Test
    fun debugSeedsEmulatorDevServer() {
        assertEquals(
            "http://10.0.2.2:3005",
            SyncManager.defaultServer(isDebug = true),
        )
    }

    @Test
    fun releaseSeedsEmptyServer() {
        assertEquals("", SyncManager.defaultServer(isDebug = false))
    }

    @Test
    fun validateServerUrlMatchesSharedFixture() {
        val fixtureFile = File("../../../tests/conformance/server-url.json")
        val cases = JSONObject(fixtureFile.readText()).getJSONArray("cases")
        assertEquals("shared fixture case count", 9, cases.length())

        for (index in 0 until cases.length()) {
            val testCase = cases.getJSONObject(index)
            val input = testCase.getString("input")
            val expected = if (testCase.isNull("expected")) null else testCase.getString("expected")
            assertEquals("input ${input.replace(" ", "\u2420")}", expected, SyncManager.validateServerUrl(input))
        }
    }

    @Test
    fun terminalLiveSessionErrorsTriggerHealing() {
        assertTrue(SyncManager.shouldHealLiveError("auth: HTTP 401: invalid session"))
        assertTrue(SyncManager.shouldHealLiveError("collection-gone: HTTP 404"))
        assertFalse(SyncManager.shouldHealLiveError("stream: connection reset"))
        assertFalse(SyncManager.shouldHealLiveError("HTTP 500"))
    }

    @Test
    fun recoverableLiveErrorSurfacesWhenHealingCannotStart() {
        val manager = SyncManager()

        manager.handleLiveError("auth: HTTP 401: invalid session")

        assertEquals("auth: HTTP 401: invalid session", manager.lastError)
        assertEquals("Error", manager.status)
    }
}

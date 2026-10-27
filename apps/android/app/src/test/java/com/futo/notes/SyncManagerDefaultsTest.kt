package com.futo.notes

import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
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
@OptIn(ExperimentalCoroutinesApi::class)
class SyncManagerDefaultsTest {
    // SyncManager builds its scope on Dispatchers.Main.immediate, which a JVM
    // test has no platform dispatcher for; kotlinx-coroutines-test 1.11 throws
    // on that access (1.8 tolerated it).
    @Before
    fun mainIsTheTestThread() = Dispatchers.setMain(UnconfinedTestDispatcher())

    @After
    fun restoreMain() = Dispatchers.resetMain()

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
    fun onlyHttpsServersNeedThePlatformTrustBinding() {
        assertTrue(SyncManager.needsPlatformTrust("https://notes.example.org"))
        assertTrue(SyncManager.needsPlatformTrust("  HTTPS://notes.example.org  "))
        assertFalse(SyncManager.needsPlatformTrust("http://192.168.1.10:3000"))
        assertFalse(SyncManager.needsPlatformTrust("http://10.0.2.2:3005"))
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

        assertEquals("auth: HTTP 401: invalid session", manager.lastErrorDiagnostic)
        assertEquals("sync.status.error", manager.statusMessage.path)
    }
}

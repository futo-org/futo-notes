package com.futo.notes

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Regression guard for the user decision: the SYNC server URL seed default
 * must be the emulator dev server in DEBUG builds and EMPTY in RELEASE builds
 * (release blocks cleartext HTTP — see AndroidManifest usesCleartextTraffic).
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
}

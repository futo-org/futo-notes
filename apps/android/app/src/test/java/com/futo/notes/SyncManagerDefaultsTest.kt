package com.futo.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
    fun acceptsUrlsWithScheme() {
        assertNull(SyncManager.validateServerUrl("https://notes.example.com"))
        assertNull(SyncManager.validateServerUrl("http://10.0.2.2:3005"))
        // Case-insensitive scheme, surrounding whitespace tolerated.
        assertNull(SyncManager.validateServerUrl("  HTTPS://notes.example.com  "))
    }

    @Test
    fun rejectsSchemelessUrlWithActionableMessage() {
        val msg = SyncManager.validateServerUrl("notes.example.com")
        assertTrue(msg!!.contains("http://"))
        assertTrue(msg.contains("https://"))
    }

    @Test
    fun rejectsEmptyUrl() {
        assertEquals("Enter a server URL.", SyncManager.validateServerUrl("   "))
    }
}

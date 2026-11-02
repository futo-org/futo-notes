package com.futo.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CrashlogEndpointTest {
    @Test
    fun localUploadsUseThisBuildsCollectorPort() {
        assertTrue(BuildConfig.DEV_CRASHLOG_PORT in 5100..5149)
        assertEquals(
            "http://10.0.2.2:${BuildConfig.DEV_CRASHLOG_PORT}",
            CrashlogEndpoint.devBaseUrl(useStaging = false),
        )
    }

    @Test
    fun stagingUploadsRemainIndependentOfLocalPort() {
        assertEquals(
            "https://staging-notes-crashlog.futo.org",
            CrashlogEndpoint.devBaseUrl(useStaging = true),
        )
    }

    @Test
    fun devInstallsNeverResolveToProduction() {
        assertEquals(
            "http://10.0.2.2:${BuildConfig.DEV_CRASHLOG_PORT}",
            CrashlogEndpoint.baseUrlFor(isDevBuild = true, useStaging = false),
        )
        assertEquals(
            "https://staging-notes-crashlog.futo.org",
            CrashlogEndpoint.baseUrlFor(isDevBuild = true, useStaging = true),
        )
    }

    @Test
    fun productionInstallIgnoresTheStagingFlag() {
        val production = "https://notes-crashlog.futo.org"
        assertEquals(production, CrashlogEndpoint.baseUrlFor(isDevBuild = false, useStaging = false))
        assertEquals(production, CrashlogEndpoint.baseUrlFor(isDevBuild = false, useStaging = true))
    }
}

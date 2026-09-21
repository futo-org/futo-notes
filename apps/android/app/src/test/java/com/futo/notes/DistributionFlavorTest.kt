package com.futo.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Locks the `direct` / `play` distribution flavors' contract (apps/android/AGENTS.md,
 * "Distribution flavors"). Runs under BOTH flavors — `:app:testDirectDebugUnitTest`
 * and `:app:testPlayDebugUnitTest` — which is what makes it a lock rather than a
 * sample: every assertion is evaluated once with `IS_PLAY_BUILD` false and once
 * with it true.
 */
class DistributionFlavorTest {
    @Test
    fun everyBuildDeclaresAKnownDistributionFlavor() {
        assertTrue(
            "unknown distribution flavor: '${BuildConfig.FLAVOR}'",
            BuildConfig.FLAVOR in setOf("direct", "play"),
        )
    }

    @Test
    fun onlyThePlayFlavorReportsIsPlayBuild() {
        assertEquals(BuildConfig.FLAVOR == "play", BuildConfig.IS_PLAY_BUILD)
    }

    @Test
    fun bothFlavorsShareOneApplicationId() {
        // The load-bearing one: a Play install and a direct APK must be the SAME
        // app, so neither flavor may contribute anything to the application id.
        // Exact equality, not a suffix strip — `.dev` is the build type's (M3),
        // and a flavor that appended its own would still have to show up here.
        // Unit tests only ever run on debug variants, and a flavor's
        // applicationIdSuffix applies to all of its variants, so a release-only
        // escape would need machinery that does not exist in this build file.
        assertEquals(
            if (BuildConfig.DEBUG) "com.futo.notes.dev" else "com.futo.notes",
            BuildConfig.APPLICATION_ID,
        )
    }
}

package com.futo.notes.license

import com.futo.notes.BuildConfig
import org.junit.Assert.assertEquals
import org.junit.Test
import uniffi.futo_notes_ffi.LicenseDistribution

/**
 * Each flavor reports where it is installed from (docs/spec/license.md § Store
 * posture), locked on BOTH distribution flavors — this suite runs as
 * `:app:testDirectDebugUnitTest` AND `:app:testPlayDebugUnitTest`, which is the
 * only reason a per-flavor constant is verified on both sides rather than on
 * whichever one happened to build. What each value means for buying is Rust's
 * (`licensePurchaseSurface`), not Gradle's.
 */
class LicenseDistributionTest {
    @Test
    fun flavorReportsItsDistribution() {
        assertEquals(
            if (BuildConfig.FLAVOR == "play") LicenseDistribution.ANDROID_PLAY else LicenseDistribution.ANDROID_DIRECT,
            BuildConfig.LICENSE_DISTRIBUTION,
        )
    }
}

package com.futo.notes.license

import com.futo.notes.BuildConfig
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The store-posture flag (docs/spec/license.md § Store posture), locked on BOTH
 * distribution flavors — this suite runs as `:app:testDirectDebugUnitTest` AND
 * `:app:testPlayDebugUnitTest`, which is the only reason a per-flavor constant
 * is verified on both sides rather than on whichever one happened to build.
 *
 * Direct offers checkout worldwide; Play accepts keys and deep links only.
 */
class LicenseLinkOutTest {
    @Test
    fun flavorControlsLinkOut() {
        assertEquals(BuildConfig.FLAVOR == "direct", BuildConfig.LICENSE_LINK_OUT)
    }
}

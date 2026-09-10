package com.futo.notes.license

import com.futo.notes.BuildConfig
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The store-posture flag (docs/spec/license.md § Store posture), locked on BOTH
 * distribution flavors — this suite runs as `:app:testDirectDebugUnitTest` AND
 * `:app:testPlayDebugUnitTest`, which is the only reason a per-flavor constant
 * is verified on both sides rather than on whichever one happened to build.
 *
 * `true` at launch everywhere: the app ships the full surface worldwide — key
 * field, deep link, and the Buy link out to the system browser. If Google
 * objects, the answer is flipping the `play` flavor's `buildConfigField` in
 * `app/build.gradle.kts`, and this assertion, to false — not a redesign. WHICH
 * controls each value produces is Rust's (`licenseRowActions`, exercised over
 * both values by `LicenseSurfaceTest`), so the flag cannot come to mean
 * something different on Android than it does on iOS.
 */
class LicenseLinkOutTest {
    @Test
    fun bothFlavorsLinkOutAtLaunch() {
        assertTrue(
            "LICENSE_LINK_OUT is false on the ${BuildConfig.FLAVOR} flavor",
            BuildConfig.LICENSE_LINK_OUT,
        )
    }
}

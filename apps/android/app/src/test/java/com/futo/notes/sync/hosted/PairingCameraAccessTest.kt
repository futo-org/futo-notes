package com.futo.notes.sync.hosted

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Android answers a permission question with two booleans that only mean
 * something together. Reading them wrong is how a scanner screen ends up
 * silently asking nothing, or offering a Settings button to someone who has
 * simply never been asked.
 */
class PairingCameraAccessTest {
    @Test
    fun `permission held means the camera runs`() {
        assertEquals(
            PairingCameraAccess.READY,
            pairingCameraAccess(
                hasCamera = true,
                granted = true,
                askedAlready = true,
                shouldShowRationale = false,
            ),
        )
    }

    @Test
    fun `never asked means ask, which is what the moment of use is`() {
        assertEquals(
            PairingCameraAccess.ASK,
            pairingCameraAccess(
                hasCamera = true,
                granted = false,
                askedAlready = false,
                shouldShowRationale = false,
            ),
        )
    }

    @Test
    fun `refused once, with another ask allowed, explains before asking again`() {
        assertEquals(
            PairingCameraAccess.RATIONALE,
            pairingCameraAccess(
                hasCamera = true,
                granted = false,
                askedAlready = true,
                shouldShowRationale = true,
            ),
        )
    }

    /**
     * The case the `askedAlready` flag exists for: Android reports no rationale
     * owed BOTH before the first ask and after a final refusal, so without this
     * screen's own memory the two are indistinguishable — and a final refusal
     * would loop on a system dialog that never appears.
     */
    @Test
    fun `refused for good offers the settings screen instead of asking again`() {
        assertEquals(
            PairingCameraAccess.DENIED,
            pairingCameraAccess(
                hasCamera = true,
                granted = false,
                askedAlready = true,
                shouldShowRationale = false,
            ),
        )
    }

    @Test
    fun `no camera outranks every permission answer`() {
        listOf(true, false).forEach { granted ->
            listOf(true, false).forEach { asked ->
                assertEquals(
                    PairingCameraAccess.NO_CAMERA,
                    pairingCameraAccess(
                        hasCamera = false,
                        granted = granted,
                        askedAlready = asked,
                        shouldShowRationale = false,
                    ),
                )
            }
        }
    }

    /**
     * A device that opened its rationale screen and then had the permission
     * granted from system settings comes back to a live camera, not to the
     * explanation it left on.
     */
    @Test
    fun `a grant from elsewhere wins over a pending rationale`() {
        assertEquals(
            PairingCameraAccess.READY,
            pairingCameraAccess(
                hasCamera = true,
                granted = true,
                askedAlready = true,
                shouldShowRationale = true,
            ),
        )
    }
}

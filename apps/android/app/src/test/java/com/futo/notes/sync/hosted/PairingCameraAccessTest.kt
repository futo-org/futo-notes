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
    private data class Case(
        val name: String,
        val granted: Boolean,
        val askedAlready: Boolean,
        val shouldShowRationale: Boolean,
        val expected: PairingCameraAccess,
    )

    @Test
    fun `the permission flags read into one screen state`() {
        listOf(
            Case(
                "permission held means the camera runs",
                granted = true, askedAlready = true, shouldShowRationale = false,
                expected = PairingCameraAccess.READY,
            ),
            Case(
                "never asked means ask",
                granted = false, askedAlready = false, shouldShowRationale = false,
                expected = PairingCameraAccess.ASK,
            ),
            Case(
                "refused once explains before asking again",
                granted = false, askedAlready = true, shouldShowRationale = true,
                expected = PairingCameraAccess.RATIONALE,
            ),
            // The case `askedAlready` exists for: Android reports no rationale owed
            // BOTH before the first ask and after a final refusal, so without this
            // screen's own memory a final refusal would loop on a system dialog
            // that never appears.
            Case(
                "refused for good offers the settings screen",
                granted = false, askedAlready = true, shouldShowRationale = false,
                expected = PairingCameraAccess.DENIED,
            ),
            // A grant from system settings while the rationale was showing comes
            // back to a live camera, not to the explanation it left on.
            Case(
                "a grant from elsewhere wins over a pending rationale",
                granted = true, askedAlready = true, shouldShowRationale = true,
                expected = PairingCameraAccess.READY,
            ),
        ).forEach { case ->
            assertEquals(
                case.name,
                case.expected,
                pairingCameraAccess(
                    hasCamera = true,
                    granted = case.granted,
                    askedAlready = case.askedAlready,
                    shouldShowRationale = case.shouldShowRationale,
                ),
            )
        }
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
}

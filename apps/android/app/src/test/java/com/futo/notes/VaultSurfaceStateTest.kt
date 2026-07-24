package com.futo.notes

import org.junit.Assert.assertTrue
import org.junit.Test

class VaultSurfaceStateTest {
    @Test
    fun `storage switch keeps the editor shell mounted behind the blocking overlay`() {
        val surface = vaultSurfaceState(
            hasStore = true,
            needsRegrant = false,
            storageSwitching = true,
        )

        assertTrue(surface.renderShell)
        assertTrue(surface.showMovingOverlay)
    }
}

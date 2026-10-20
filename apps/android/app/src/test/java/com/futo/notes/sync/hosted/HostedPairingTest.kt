package com.futo.notes.sync.hosted

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import uniffi.futo_notes_ffi.HostedException
import uniffi.futo_notes_ffi.PairingOutcome

/** Pairing, both sides, against the stand-ins in HostedSetupStandIns.kt. */
class HostedPairingTest {
    // ── Pairing: the show side (this device is the new one) ──────────────

    @Test
    fun `showing a code carries this device's name and the relay's deadline`() = runBlocking {
        val setup = lockedSetup()
        val shell = StandInShell().apply { reportedName = "Justin's Pixel" }
        val wizard = model(setup, shell, StandInScannedPairing())

        wizard.load()
        wizard.chooseDoor(UnlockDoor.SCAN)
        wizard.showPairingCode()

        assertEquals("Justin's Pixel", setup.beganPairingAs)
        assertEquals("2026-09-15T20:05:00Z", wizard.pairingExpiresAt)
    }

    @Test
    fun `a key that arrives unlocks the vault and reaches the account screen`() = runBlocking {
        val setup = lockedSetup()
        val wizard = model(setup, StandInShell(), StandInScannedPairing())

        wizard.load()
        wizard.showPairingCode()

        assertEquals(PairingState.RECEIVED, wizard.pairing)
        assertEquals(HostedScreen.ACCOUNT, wizard.screen)
        // The code is gone the moment it is spent, so a dead code is never on
        // screen next to a live countdown.
        assertNull(wizard.pairingPayload)
        assertNull(wizard.errorMessage)
    }

    /**
     * The relay carries no declined signal: saying no on the other device sends
     * nothing, so a decline and a walk-away both arrive here as the five
     * minutes running out. Rust's answer is what this renders — the wording on
     * that screen is what says it could have been either.
     */
    @Test
    fun `a window that closes is expired, whoever let it close`() = runBlocking {
        val setup = lockedSetup().apply { pairingFailure = HostedException.PairingExpired() }
        val wizard = model(setup, StandInShell(), StandInScannedPairing())

        wizard.load()
        wizard.showPairingCode()

        assertEquals(PairingState.EXPIRED, wizard.pairing)
        assertNull(wizard.pairingPayload)
        // Not an error line as well: the screen already says what happened.
        assertNull(wizard.errorMessage)
    }

    @Test
    fun `a relay that will not serve the pairing is its own, narrower screen`() = runBlocking {
        listOf(
            HostedException.PairingRefused(),
            HostedException.PairingAlreadyKeyed(),
        ).forEach { failure ->
            val setup = lockedSetup().apply { pairingFailure = failure }
            val wizard = model(setup, StandInShell(), StandInScannedPairing())

            wizard.load()
            wizard.showPairingCode()

            assertEquals(PairingState.REFUSED, wizard.pairing)
        }
    }

    @Test
    fun `any other failure is a sentence, not a fifth pairing state`() = runBlocking {
        val setup = lockedSetup().apply { pairingFailure = HostedException.Network("offline") }
        val wizard = model(setup, StandInShell(), StandInScannedPairing())

        wizard.load()
        wizard.showPairingCode()

        assertEquals(PairingState.IDLE, wizard.pairing)
        assertEquals("sync.hosted.errors.network", wizard.errorMessage?.path)
    }

    @Test
    fun `cancel ends a live wait and puts the three doors back`() = runBlocking {
        val setup = lockedSetup()
        val gate = CompletableDeferred<Unit>()
        setup.pairingGate = gate
        setup.pairingOutcome = PairingOutcome.CANCELLED
        val wizard = model(setup, StandInShell(), StandInScannedPairing())
        wizard.load()

        val showing = launch { wizard.showPairingCode() }
        yield()
        assertEquals(PairingState.WAITING, wizard.pairing)

        wizard.cancelPairing()
        assertEquals(1, setup.cancelWaitCount)
        gate.complete(Unit)
        showing.join()

        assertEquals(PairingState.IDLE, wizard.pairing)
        assertNull(wizard.pairingPayload)
        assertNull(wizard.pairingExpiresAt)
    }

    @Test
    fun `leaving the scan door ends the wait too`() = runBlocking {
        val setup = lockedSetup()
        val gate = CompletableDeferred<Unit>()
        setup.pairingGate = gate
        setup.pairingOutcome = PairingOutcome.CANCELLED
        val wizard = model(setup, StandInShell(), StandInScannedPairing())
        wizard.load()
        wizard.chooseDoor(UnlockDoor.SCAN)

        val showing = launch { wizard.showPairingCode() }
        yield()
        wizard.chooseDoor(UnlockDoor.VAULT_PASSWORD)

        assertEquals(1, setup.cancelWaitCount)
        assertEquals(UnlockDoor.VAULT_PASSWORD, wizard.unlockDoor)
        gate.complete(Unit)
        showing.join()
        assertEquals(PairingState.IDLE, wizard.pairing)
    }

    @Test
    fun `showing a code again mints a new one, because a live code cannot be withdrawn`() =
        runBlocking {
            val setup = lockedSetup().apply { pairingFailure = HostedException.PairingExpired() }
            val wizard = model(setup, StandInShell(), StandInScannedPairing())

            wizard.load()
            wizard.showPairingCode()
            assertEquals(PairingState.EXPIRED, wizard.pairing)

            wizard.showPairingCode()
            assertEquals(PairingState.RECEIVED, wizard.pairing)
            assertEquals(2, setup.calls.count { it == "beginPairing" })
        }

    // ── Pairing: the scan side (this device holds the key) ───────────────

    @Test
    fun `a scanned code names the device it came from and sends nothing yet`() = runBlocking {
        val setup = unlockedSetup()
        val scanned = StandInScannedPairing(deviceName = "Justin's iPad", platform = "ios")
        val wizard = model(setup, StandInShell(), scanned)

        wizard.load()
        wizard.openScanner()
        assertEquals(ScanPhase.SCANNING, wizard.scanPhase)

        wizard.readScannedCode("{\"futo_notes_pairing\":1}")
        assertEquals(ScanPhase.CONFIRMING, wizard.scanPhase)
        assertEquals("Justin's iPad", wizard.scannedPairing?.deviceName)
        assertEquals("ios", wizard.scannedPairing?.platform)
        assertEquals(0, scanned.sends)
    }

    /** Parent spec user story 16: a wrong scan sends nothing. */
    @Test
    fun `saying no on the confirmation sends nothing and keeps nothing`() = runBlocking {
        val scanned = StandInScannedPairing()
        val wizard = model(unlockedSetup(), StandInShell(), scanned)

        wizard.load()
        wizard.openScanner()
        wizard.readScannedCode("a code")
        wizard.cancelConfirmation()

        assertEquals(0, scanned.sends)
        assertNull(wizard.scannedPairing)
        // Back to the camera, not to a dead end.
        assertEquals(ScanPhase.SCANNING, wizard.scanPhase)
    }

    @Test
    fun `send is the one call that puts a vault key on the wire`() = runBlocking {
        val scanned = StandInScannedPairing()
        val wizard = model(unlockedSetup(), StandInShell(), scanned)

        wizard.load()
        wizard.openScanner()
        wizard.readScannedCode("a code")
        wizard.sendVaultKey()

        assertEquals(1, scanned.sends)
        assertEquals(ScanPhase.SENT, wizard.scanPhase)
        assertNull(wizard.errorMessage)
    }

    @Test
    fun `nothing is sent when nothing was scanned`() = runBlocking {
        val wizard = model(unlockedSetup(), StandInShell(), StandInScannedPairing())

        wizard.load()
        wizard.openScanner()
        wizard.sendVaultKey()

        assertEquals(ScanPhase.SCANNING, wizard.scanPhase)
    }

    @Test
    fun `something that is not a pairing code is named as such, and nothing is sent`() =
        runBlocking {
            val scanned = StandInScannedPairing()
            val wizard = model(unlockedSetup(), StandInShell(), scanned) {
                throw HostedException.PairingCodeInvalid()
            }

            wizard.load()
            wizard.openScanner()
            wizard.readScannedCode("a bus ticket")

            assertEquals("sync.hosted.errors.pairingCodeInvalid", wizard.errorMessage?.path)
            assertNull(wizard.scannedPairing)
            assertEquals(0, scanned.sends)
            // The camera stays on: the next code is the way out of this.
            assertEquals(ScanPhase.SCANNING, wizard.scanPhase)
        }

    @Test
    fun `a refused send says why and puts the camera back rather than ending there`() =
        runBlocking {
            val scanned = StandInScannedPairing(failure = HostedException.PairingRefused())
            val wizard = model(unlockedSetup(), StandInShell(), scanned)

            wizard.load()
            wizard.openScanner()
            wizard.readScannedCode("a code")
            wizard.sendVaultKey()

            assertEquals("sync.hosted.errors.pairingRefused", wizard.errorMessage?.path)
            assertEquals(ScanPhase.SCANNING, wizard.scanPhase)
            assertNull(wizard.scannedPairing)
        }

    @Test
    fun `signing out takes down a live code and a live camera`() = runBlocking {
        val setup = unlockedSetup()
        val wizard = model(setup, StandInShell(), StandInScannedPairing())

        wizard.load()
        wizard.openScanner()
        wizard.readScannedCode("a code")
        wizard.signOut()

        assertEquals(ScanPhase.CLOSED, wizard.scanPhase)
        assertNull(wizard.scannedPairing)
        assertEquals(PairingState.IDLE, wizard.pairing)
        assertEquals(HostedScreen.SIGN_IN, wizard.screen)
    }
}

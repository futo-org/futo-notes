package com.futo.notes.sync.hosted

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test
import uniffi.futo_notes_ffi.SignInFlow

/** The end of the wizard is a running sync, against the stand-ins in HostedSetupStandIns.kt. */
class HostedSetupConnectTest {
    // ── The end of the wizard is a running sync ──────────────────────────

    @Test
    fun `reaching ready starts the sync, once`() = runBlocking {
        val setup = unlockedSetup()
        val session = StandInSession()
        val wizard = model(setup, session = session)

        wizard.load()

        assertEquals(HostedScreen.ACCOUNT, wizard.screen)
        assertEquals(1, session.connects)
    }

    @Test
    fun `a second read at ready does not start a second sync`() = runBlocking {
        val setup = unlockedSetup()
        val session = StandInSession()
        val wizard = model(setup, session = session)

        wizard.load()
        // Every account-card detour ends in another read of the same step.
        wizard.backToAccount()
        wizard.backToAccount()

        assertEquals(HostedScreen.ACCOUNT, wizard.screen)
        assertEquals(1, session.connects)
    }

    @Test
    fun `a door landing on ready starts the sync`() = runBlocking {
        for (door in listOf("vaultPassword", "recoveryKey", "pairing")) {
            val setup = lockedSetup()
            val session = StandInSession()
            val wizard = model(setup, session = session)

            wizard.load()
            assertEquals(HostedScreen.UNLOCK, wizard.screen)
            assertEquals("a locked device started a sync it cannot run", 0, session.connects)

            when (door) {
                "vaultPassword" -> wizard.unlockWithPassword("a long enough one")
                "recoveryKey" -> wizard.unlockWithRecoveryKey(setup.recoveryKey)
                else -> {
                    wizard.chooseDoor(UnlockDoor.SCAN)
                    wizard.showPairingCode()
                }
            }

            assertEquals("$door did not reach the account card", HostedScreen.ACCOUNT, wizard.screen)
            assertEquals("$door did not start a sync", 1, session.connects)
        }
    }

    @Test
    fun `creating a vault starts the sync only once the key is saved`() = runBlocking {
        val setup = StandInSetup()
        val session = StandInSession()
        val wizard = model(setup, session = session)

        wizard.load()
        wizard.signIn()
        wizard.subscribe()
        wizard.createVault("a long enough one")
        assertEquals(HostedScreen.RECOVERY_KEY, wizard.screen)
        assertEquals("a sync started before the key was saved", 0, session.connects)

        wizard.recoveryKeySaved = true
        wizard.continueAfterRecoveryKey()

        assertEquals(HostedScreen.ACCOUNT, wizard.screen)
        assertEquals(1, session.connects)
    }

    @Test
    fun `signing out and back in starts the next session's sync`() = runBlocking {
        val setup = unlockedSetup()
        val session = StandInSession()
        val wizard = model(setup, session = session)

        wizard.load()
        assertEquals(1, session.connects)

        wizard.signOut()
        assertEquals(HostedScreen.SIGN_IN, wizard.screen)
        assertEquals(1, session.signOuts)

        // Signing in again lands on the account card, because the vault and
        // this device's key outlived the session.
        setup.deviceHoldsKey = true
        wizard.signIn()

        assertEquals(HostedScreen.ACCOUNT, wizard.screen)
        assertEquals(2, session.connects)
    }

    @Test
    fun `the account usage is re-read once the first sync has run`() = runBlocking {
        val setup = unlockedSetup()
        setup.usedBytes = 0uL
        val session = StandInSession()
        // What the first cycle changes on the server: the vault now weighs
        // something. A card that never asked again would sit on `0 B` forever.
        val wizard = HostedSetupModel(
            makeSetup = { setup },
            shell = StandInShell(),
            signOutEffect = { setup.signOutHere() },
            connectEffect = {
                session.connects += 1
                setup.usedBytes = 4_210_688uL
            },
            effectScope = effectScope(),
            probe = { SignInFlow.Hosted(sellsSubscriptions = true) },
            readMinimumVaultPasswordLength = { 12 },
            log = {},
        )

        wizard.load()

        assertEquals(1, session.connects)
        assertEquals(4_210_688uL, wizard.billing?.bytesUsed)
    }
}

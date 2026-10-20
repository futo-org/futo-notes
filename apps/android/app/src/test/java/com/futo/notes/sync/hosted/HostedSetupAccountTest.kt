package com.futo.notes.sync.hosted

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import uniffi.futo_notes_ffi.HostedException

/** Sign out, failures, and the vault-password and recovery-key changes, against the stand-ins in HostedSetupStandIns.kt. */
class HostedSetupAccountTest {
    // ── Sign out and failures ────────────────────────────────────────────

    @Test
    fun `signing out returns the wizard to sign in`() = runBlocking {
        val setup = StandInSetup().apply {
            signedIn = true
            entitled = true
            vaultHasKeyMaterial = true
            deviceHoldsKey = true
        }
        val wizard = model(setup)

        wizard.load()
        assertEquals(HostedScreen.ACCOUNT, wizard.screen)

        wizard.signOut()

        assertTrue(setup.calls.contains("signOut"))
        assertEquals(HostedScreen.SIGN_IN, wizard.screen)
        assertTrue(wizard.email.isEmpty())
        assertNull(wizard.billing)
    }

    @Test
    fun `a failure is reported as a sentence and does not leave the screen busy`() = runBlocking {
        val setup = StandInSetup().apply {
            vaultHasKeyMaterial = true
            entitled = true
        }
        val wizard = model(setup)

        wizard.load()
        wizard.signIn()
        setup.nextFailure = HostedException.RecoveryKeyTypo()
        wizard.unlockWithRecoveryKey("ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2346")

        assertEquals("sync.hosted.errors.recoveryKeyTypo", wizard.errorMessage?.path)
        assertFalse(wizard.busy)
        assertEquals(HostedScreen.UNLOCK, wizard.screen)
    }

    @Test
    fun `an expired session is reported as sign in again, and the vault is not reset`() =
        runBlocking {
            val setup = StandInSetup().apply {
                signedIn = true
                vaultHasKeyMaterial = true
                deviceHoldsKey = true
                entitled = true
            }
            val wizard = model(setup)

            wizard.load()
            setup.nextFailure = HostedException.SignInAgain()
            wizard.manageSubscription()

            assertEquals("sync.hosted.errors.signInAgain", wizard.errorMessage?.path)
            // Still the account screen — nothing about this looks like a reset.
            assertEquals(HostedScreen.ACCOUNT, wizard.screen)
        }

    @Test
    fun `a failure clears when the next step succeeds`() = runBlocking {
        val setup = StandInSetup().apply {
            vaultHasKeyMaterial = true
            entitled = true
        }
        val wizard = model(setup)

        wizard.load()
        wizard.signIn()
        setup.nextFailure = HostedException.WrongVaultPassword()
        wizard.unlockWithPassword("wrong")
        assertEquals("sync.hosted.errors.wrongVaultPassword", wizard.errorMessage?.path)

        wizard.unlockWithPassword("a long enough one")
        assertNull(wizard.errorMessage)
        assertEquals(HostedScreen.ACCOUNT, wizard.screen)
    }

    // ── Changing the vault password, and a new recovery key ──────────────

    @Test
    fun `the new-password screen opens without asking Rust anything`() = runBlocking {
        val setup = unlockedSetup()
        val wizard = model(setup)
        wizard.load()
        assertEquals(HostedScreen.ACCOUNT, wizard.screen)
        val before = setup.calls.size

        wizard.beginChangeVaultPassword()

        assertEquals(HostedScreen.CHANGE_VAULT_PASSWORD, wizard.screen)
        assertEquals(before, setup.calls.size)
    }

    @Test
    fun `only the new password is sent, and the card comes back`() = runBlocking {
        val setup = unlockedSetup()
        val shell = StandInShell()
        val wizard = model(setup, shell)
        wizard.load()
        wizard.beginChangeVaultPassword()

        wizard.changeVaultPassword("Tr0ubadour&Horse!")

        assertEquals("Tr0ubadour&Horse!", setup.vaultPassword)
        assertEquals(1, setup.calls.count { it == "changeVaultPassword" })
        assertEquals(HostedScreen.ACCOUNT, wizard.screen)
        assertNull(wizard.errorMessage)
        assertTrue(shell.announcements.contains("sync.hosted.vaultPassword.change.changed"))
    }

    @Test
    fun `a stale-key conflict keeps the screen up, and the retry lands`() = runBlocking {
        val setup = unlockedSetup()
        val wizard = model(setup)
        wizard.load()
        wizard.beginChangeVaultPassword()
        setup.nextFailure = HostedException.VaultKeyChangedElsewhere()

        wizard.changeVaultPassword("Tr0ubadour&Horse!")

        assertEquals(HostedScreen.CHANGE_VAULT_PASSWORD, wizard.screen)
        assertEquals(
            "sync.hosted.errors.vaultKeyChangedElsewhere",
            wizard.errorMessage?.path,
        )

        wizard.changeVaultPassword("Tr0ubadour&Horse!")

        assertEquals(HostedScreen.ACCOUNT, wizard.screen)
        assertNull(wizard.errorMessage)
        assertEquals("Tr0ubadour&Horse!", setup.vaultPassword)
    }

    @Test
    fun `backing out changes nothing`() = runBlocking {
        val setup = unlockedSetup()
        val wizard = model(setup)
        wizard.load()
        val password = setup.vaultPassword
        wizard.beginChangeVaultPassword()

        wizard.backToAccount()

        assertEquals(HostedScreen.ACCOUNT, wizard.screen)
        assertEquals(password, setup.vaultPassword)
        assertFalse(setup.calls.contains("changeVaultPassword"))
    }

    @Test
    fun `a new recovery key reuses the save screen, marked a replacement`() = runBlocking {
        val setup = unlockedSetup()
        val wizard = model(setup)
        wizard.load()

        wizard.newRecoveryKey()

        assertEquals(HostedScreen.RECOVERY_KEY, wizard.screen)
        assertEquals("ZYXW-VTSR-QPNM-KJHG-FEDC-BA98-7654", wizard.recoveryKey)
        assertTrue(wizard.recoveryKeyReplaced)
        assertFalse(wizard.recoveryKeySaved)
    }

    @Test
    fun `continuing ends the replacement key, with no second copy to ask for`() = runBlocking {
        val setup = unlockedSetup()
        val wizard = model(setup)
        wizard.load()
        wizard.newRecoveryKey()

        wizard.continueAfterRecoveryKey()

        assertNull(wizard.recoveryKey)
        assertFalse(wizard.recoveryKeyReplaced)
        assertEquals(HostedScreen.ACCOUNT, wizard.screen)
        assertEquals(1, setup.calls.count { it == "newRecoveryKey" })
    }

    @Test
    fun `a locked device is told why, not left on a half screen`() = runBlocking {
        val wizard = model(lockedSetup())
        wizard.load()
        assertEquals(HostedScreen.UNLOCK, wizard.screen)

        wizard.newRecoveryKey()

        assertNull(wizard.recoveryKey)
        assertEquals("sync.hosted.errors.vaultLocked", wizard.errorMessage?.path)
    }
}

package com.futo.notes.sync.hosted

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import uniffi.futo_notes_ffi.BillingStatus
import uniffi.futo_notes_ffi.Checkout
import uniffi.futo_notes_ffi.SignInFlow
import uniffi.futo_notes_ffi.SignInOutcome
import uniffi.futo_notes_ffi.WriteRefusal

/**
 * The Android wizard, driven against a stand-in for Rust's state machine.
 *
 * The stand-in derives its step from the same four facts Rust does — is there a
 * session, does the vault have key material, does this device hold the key, may
 * the account write — so a test that walks a wizard shape is testing that the
 * shell *follows* those facts rather than counting screens of its own.
 */
class HostedSetupModelTest {
    // ── The two wizard shapes ────────────────────────────────────────────

    @Test
    fun `a fresh account walks sign in, subscribe, vault password, recovery key, account`() =
        runBlocking {
            val setup = StandInSetup()
            val shell = StandInShell()
            val wizard = model(setup, shell)

            wizard.load()
            assertEquals(HostedScreen.SIGN_IN, wizard.screen)

            wizard.signIn()
            assertEquals(HostedScreen.SUBSCRIBE, wizard.screen)
            assertEquals(listOf("https://accounts.example/handoff"), shell.openedUrls)

            wizard.subscribe()
            assertEquals(HostedScreen.CREATE_VAULT, wizard.screen)
            assertEquals(2, shell.openedUrls.size)

            wizard.createVault("a long enough one")
            assertEquals(HostedScreen.RECOVERY_KEY, wizard.screen)
            assertEquals(setup.recoveryKey, wizard.recoveryKey)

            wizard.recoveryKeySaved = true
            wizard.continueAfterRecoveryKey()
            assertEquals(HostedScreen.ACCOUNT, wizard.screen)
            assertEquals("person@futo.org", wizard.email)
            assertNull(wizard.errorMessage)
        }

    @Test
    fun `an account that already has a vault walks sign in, unlock, account`() = runBlocking {
        val setup = StandInSetup().apply {
            vaultHasKeyMaterial = true
            entitled = true
        }
        val wizard = model(setup)

        wizard.load()
        wizard.signIn()
        assertEquals(HostedScreen.UNLOCK, wizard.screen)

        wizard.unlockWithPassword("a long enough one")
        assertEquals(HostedScreen.ACCOUNT, wizard.screen)
        assertTrue(setup.calls.contains("unlockWithVaultPassword"))
        // No subscribe step in this shape: reads are never entitlement-gated.
        assertFalse(setup.calls.contains("beginCheckout"))
    }

    @Test
    fun `the recovery-key door reaches the same account screen`() = runBlocking {
        val setup = StandInSetup().apply {
            vaultHasKeyMaterial = true
            entitled = true
        }
        val wizard = model(setup)

        wizard.load()
        wizard.signIn()
        wizard.chooseDoor(UnlockDoor.RECOVERY_KEY)
        wizard.unlockWithRecoveryKey("abcd efgh jkmn pqrs tvwx yz01 2345")

        assertEquals(HostedScreen.ACCOUNT, wizard.screen)
        assertTrue(setup.calls.contains("unlockWithRecoveryKey"))
    }

    // ── Where the wizard's position comes from ───────────────────────────

    @Test
    fun `the step is read from the state machine, never remembered here`() = runBlocking {
        val setup = StandInSetup().apply {
            signedIn = true
            entitled = true
            vaultHasKeyMaterial = true
            deviceHoldsKey = true
        }

        val wizard = model(setup)
        wizard.load()
        assertEquals(HostedScreen.ACCOUNT, wizard.screen)

        // The same facts a cold start would read, changed behind the shell's
        // back: a device that lost its key is on the unlock screen next time,
        // with nothing in Kotlin having been told.
        setup.deviceHoldsKey = false
        wizard.load()
        assertEquals(HostedScreen.UNLOCK, wizard.screen)

        // And a brand-new model over the same facts lands in the same place —
        // there is no position to carry over.
        val coldStart = model(setup)
        coldStart.load()
        assertEquals(HostedScreen.UNLOCK, coldStart.screen)
    }

    @Test
    fun `a server without FUTO accounts says so instead of opening a tab`() = runBlocking {
        val shell = StandInShell()
        val wizard = model(StandInSetup(), shell, flow = SignInFlow.Password)

        wizard.load()

        assertEquals(HostedScreen.UNAVAILABLE, wizard.screen)
        assertTrue(shell.openedUrls.isEmpty())
    }

    // ── The browser tab ──────────────────────────────────────────────────

    @Test
    fun `coming back from the sign-in tab leaves the screen where it was, with no error`() =
        runBlocking {
            val setup = StandInSetup().apply { signInOutcome = SignInOutcome.Cancelled }
            val shell = StandInShell().apply { dismissImmediately = true }
            val wizard = model(setup, shell)

            wizard.load()
            wizard.signIn()

            assertEquals(HostedScreen.SIGN_IN, wizard.screen)
            assertNull(wizard.errorMessage)
            assertNull(wizard.waiting)
            assertEquals(1, setup.cancelWaitCount)
        }

    @Test
    fun `leaving the tab stops the wait rather than leaving it running`() = runBlocking {
        val setup = StandInSetup().apply { signInOutcome = SignInOutcome.Cancelled }
        val shell = StandInShell()
        val wizard = model(setup, shell)

        wizard.load()
        wizard.signIn()
        assertEquals(0, setup.cancelWaitCount)

        shell.leaveTab()
        assertEquals(1, setup.cancelWaitCount)
    }

    @Test
    fun `a sign-in that took too long says to try again`() = runBlocking {
        val setup = StandInSetup().apply { signInOutcome = SignInOutcome.Expired }
        val wizard = model(setup)

        wizard.load()
        wizard.signIn()

        assertEquals(HostedScreen.SIGN_IN, wizard.screen)
        assertEquals("sync.hosted.errors.signInExpired", wizard.errorMessage?.path)
    }

    @Test
    fun `pressing Cancel on the screen takes the tab down too`() = runBlocking {
        val setup = StandInSetup()
        val shell = StandInShell()
        val wizard = model(setup, shell)

        wizard.load()
        wizard.cancelWaiting()

        assertEquals(1, setup.cancelWaitCount)
        assertTrue(shell.closes >= 1)
        assertNull(wizard.waiting)
    }

    @Test
    fun `an account that is already entitled skips checkout entirely`() = runBlocking {
        val setup = StandInSetup()
        setup.checkout = Checkout.AlreadyEntitled(
            BillingStatus(
                entitled = true,
                state = "active",
                graceUntil = null,
                storageQuotaBytes = 1uL,
                blobMaxBytes = 1uL,
                bytesUsed = 0uL,
            ),
        )
        val shell = StandInShell()
        val wizard = model(setup, shell)

        wizard.load()
        wizard.signIn()
        setup.entitled = true
        wizard.subscribe()

        assertEquals(HostedScreen.CREATE_VAULT, wizard.screen)
        assertEquals(1, shell.openedUrls.size) // sign-in only
    }

    @Test
    fun `Manage subscription opens a portal URL minted for that press`() = runBlocking {
        val setup = StandInSetup().apply {
            signedIn = true
            entitled = true
            vaultHasKeyMaterial = true
            deviceHoldsKey = true
        }
        val shell = StandInShell()
        val wizard = model(setup, shell)

        wizard.load()
        wizard.manageSubscription()

        assertEquals(listOf(setup.portalUrl), shell.openedUrls)
    }

    // ── The recovery key ─────────────────────────────────────────────────

    @Test
    fun `the recovery key is shown once and there is no way back to it`() = runBlocking {
        val setup = StandInSetup().apply { entitled = true }
        val shell = StandInShell()
        val wizard = model(setup, shell)

        wizard.load()
        wizard.signIn()
        wizard.createVault("a long enough one")
        assertEquals(setup.recoveryKey, wizard.recoveryKey)

        wizard.copyRecoveryKey()
        assertEquals(setup.recoveryKey, shell.clipboard)
        assertEquals(listOf("sync.hosted.recoveryKey.copied"), shell.announcements)

        wizard.shareRecoveryKey()
        assertEquals(setup.recoveryKey, shell.shared)

        wizard.recoveryKeySaved = true
        wizard.continueAfterRecoveryKey()
        assertNull(wizard.recoveryKey)
        assertFalse(wizard.recoveryKeySaved)

        // Asking the engine again is refused, so there is no second showing
        // even if a shell tried.
        wizard.createVault("a long enough one")
        assertNull(wizard.recoveryKey)
        assertEquals("sync.hosted.errors.vaultAlreadyExists", wizard.errorMessage?.path)
    }

    // ── Banners ──────────────────────────────────────────────────────────

    @Test
    fun `a lapsed subscription raises Sync paused, and only on the account screen`() =
        runBlocking {
            val setup = StandInSetup().apply {
                signedIn = true
                vaultHasKeyMaterial = true
                deviceHoldsKey = true
                entitled = false
                state = "canceled"
            }
            val wizard = model(setup)

            wizard.load()
            assertEquals(HostedScreen.ACCOUNT, wizard.screen)
            assertEquals(HostedBanner.SYNC_PAUSED, wizard.banner)
        }

    @Test
    fun `a full vault raises Vault is full`() = runBlocking {
        val setup = StandInSetup().apply {
            signedIn = true
            vaultHasKeyMaterial = true
            deviceHoldsKey = true
            entitled = true
        }
        setup.usedBytes = setup.quotaBytes
        val wizard = model(setup)

        wizard.load()
        assertEquals(HostedBanner.VAULT_FULL, wizard.banner)
    }

    @Test
    fun `Sync paused wins over a full vault, because the subscription refuses first`() =
        runBlocking {
            val setup = StandInSetup().apply {
                signedIn = true
                vaultHasKeyMaterial = true
                deviceHoldsKey = true
                entitled = false
            }
            setup.usedBytes = setup.quotaBytes
            val wizard = model(setup)

            wizard.load()
            assertEquals(HostedBanner.SYNC_PAUSED, wizard.banner)
        }

    @Test
    fun `no banner while the wizard is still running`() = runBlocking {
        val setup = StandInSetup().apply {
            signedIn = true
            entitled = false
        }
        val wizard = model(setup)

        wizard.load()
        assertEquals(HostedScreen.SUBSCRIBE, wizard.screen)
        assertEquals(HostedBanner.NONE, wizard.banner)
    }

    // The second input: the last completed cycle's own 402/507, decided in
    // Rust. It is what makes the banner appear the moment the refused cycle
    // ends, instead of on the next billing read.

    @Test
    fun `a refused cycle raises the banner with a healthy billing reading`() = runBlocking {
        val setup = StandInSetup().apply {
            signedIn = true
            vaultHasKeyMaterial = true
            deviceHoldsKey = true
            entitled = true
        }
        val wizard = model(setup)

        wizard.load()
        assertEquals(HostedBanner.NONE, wizard.banner)

        wizard.writeRefusal = WriteRefusal.SUBSCRIPTION_REQUIRED
        assertEquals(HostedBanner.SYNC_PAUSED, wizard.banner)

        wizard.writeRefusal = WriteRefusal.QUOTA_EXCEEDED
        assertEquals(HostedBanner.VAULT_FULL, wizard.banner)
    }

    @Test
    fun `Sync paused wins over a full vault whichever input says so`() = runBlocking {
        val full = StandInSetup().apply {
            signedIn = true
            vaultHasKeyMaterial = true
            deviceHoldsKey = true
            entitled = true
        }
        full.usedBytes = full.quotaBytes
        val onFullVault = model(full)
        onFullVault.load()
        assertEquals(HostedBanner.VAULT_FULL, onFullVault.banner)

        // A lapse refuses the write whatever the quota says, so "buy more
        // storage" would be the wrong instruction.
        onFullVault.writeRefusal = WriteRefusal.SUBSCRIPTION_REQUIRED
        assertEquals(HostedBanner.SYNC_PAUSED, onFullVault.banner)

        val lapsed = StandInSetup().apply {
            signedIn = true
            vaultHasKeyMaterial = true
            deviceHoldsKey = true
            entitled = false
        }
        val onLapsed = model(lapsed)
        onLapsed.load()
        onLapsed.writeRefusal = WriteRefusal.QUOTA_EXCEEDED
        assertEquals(HostedBanner.SYNC_PAUSED, onLapsed.banner)
    }

    @Test
    fun `a cycle that was not refused leaves the billing reading in charge`() = runBlocking {
        val setup = StandInSetup().apply {
            signedIn = true
            vaultHasKeyMaterial = true
            deviceHoldsKey = true
            entitled = true
        }
        val wizard = model(setup)

        wizard.load()
        wizard.writeRefusal = WriteRefusal.QUOTA_EXCEEDED
        assertEquals(HostedBanner.VAULT_FULL, wizard.banner)

        wizard.writeRefusal = null
        assertEquals(HostedBanner.NONE, wizard.banner)
    }

    @Test
    fun `a refusal from the last account never greets the next one`() = runBlocking {
        val setup = StandInSetup().apply {
            signedIn = true
            entitled = false
        }
        val wizard = model(setup)

        wizard.load()
        assertEquals(HostedScreen.SUBSCRIBE, wizard.screen)

        wizard.writeRefusal = WriteRefusal.SUBSCRIPTION_REQUIRED
        assertEquals(HostedBanner.NONE, wizard.banner)
    }
}

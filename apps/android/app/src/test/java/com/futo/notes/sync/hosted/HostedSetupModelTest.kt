package com.futo.notes.sync.hosted

import com.futo.notes.localization.LocalizedMessage
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import uniffi.futo_notes_ffi.BillingStatus
import uniffi.futo_notes_ffi.Checkout
import uniffi.futo_notes_ffi.EntitlementOutcome
import uniffi.futo_notes_ffi.HostedException
import uniffi.futo_notes_ffi.HostedSession
import uniffi.futo_notes_ffi.HostedSetupClientInterface
import uniffi.futo_notes_ffi.PairingCode
import uniffi.futo_notes_ffi.PairingOutcome
import uniffi.futo_notes_ffi.PairingRequest
import uniffi.futo_notes_ffi.SetupStep
import uniffi.futo_notes_ffi.SignInFlow
import uniffi.futo_notes_ffi.SignInHandoff
import uniffi.futo_notes_ffi.SignInOutcome
import uniffi.futo_notes_ffi.SyncClient

/**
 * The Android wizard, driven against a stand-in for Rust's state machine.
 *
 * The stand-in derives its step from the same four facts Rust does — is there a
 * session, does the vault have key material, does this device hold the key, may
 * the account write — so a test that walks a wizard shape is testing that the
 * shell *follows* those facts rather than counting screens of its own.
 */
class HostedSetupModelTest {

    // ── Stand-ins ────────────────────────────────────────────────────────

    /** Rust's `HostedSetup`, as far as the wizard can tell. */
    private class StandInSetup : HostedSetupClientInterface {
        var signedIn = false
        var entitled = false
        var vaultHasKeyMaterial = false
        var deviceHoldsKey = false

        var signInOutcome: SignInOutcome = SignInOutcome.SignedIn(
            HostedSession("user-1", "person@futo.org", "Person", "token"),
        )
        var checkout: Checkout = Checkout.Open("https://pay.example/checkout")
        var entitlementOutcome: EntitlementOutcome? = null
        var state = "active"
        var graceUntil: String? = null
        var quotaBytes: ULong = 10_000_000_000uL
        var usedBytes: ULong = 4_210_688uL
        var portalUrl = "https://pay.example/portal"
        var recoveryKey = "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345"

        var nextFailure: HostedException? = null
        var cancelWaitCount = 0
        val calls = mutableListOf<String>()

        override fun serverUrl() = "https://notes-sync.example"

        override fun session(): HostedSession? {
            val outcome = signInOutcome
            if (!signedIn || outcome !is SignInOutcome.SignedIn) return null
            return outcome.session
        }

        override suspend fun beginSignIn(): SignInHandoff {
            record("beginSignIn")
            return SignInHandoff("https://accounts.example/handoff", "ticket")
        }

        override suspend fun awaitSignIn(handoff: SignInHandoff): SignInOutcome {
            record("awaitSignIn")
            if (signInOutcome is SignInOutcome.SignedIn) signedIn = true
            return signInOutcome
        }

        override fun cancelWait() {
            cancelWaitCount += 1
        }

        override suspend fun currentStep(): SetupStep {
            record("currentStep")
            if (!signedIn) return SetupStep.SIGN_IN
            if (vaultHasKeyMaterial) {
                return if (deviceHoldsKey) SetupStep.READY else SetupStep.UNLOCK
            }
            return if (entitled) SetupStep.CREATE_VAULT else SetupStep.SUBSCRIBE
        }

        override suspend fun billingStatus(): BillingStatus {
            record("billingStatus")
            return BillingStatus(
                entitled = entitled,
                state = state,
                graceUntil = graceUntil,
                storageQuotaBytes = quotaBytes,
                blobMaxBytes = 104_857_600uL,
                bytesUsed = usedBytes,
            )
        }

        override suspend fun billingPortal(): String {
            record("billingPortal")
            return portalUrl
        }

        override suspend fun beginCheckout(): Checkout {
            record("beginCheckout")
            return checkout
        }

        override suspend fun awaitEntitled(): EntitlementOutcome {
            record("awaitEntitled")
            entitlementOutcome?.let { return it }
            entitled = true
            return EntitlementOutcome.Entitled(billingStatus())
        }

        override suspend fun createVault(vaultPassword: String): String {
            record("createVault")
            if (vaultHasKeyMaterial) throw HostedException.VaultAlreadyExists()
            vaultHasKeyMaterial = true
            deviceHoldsKey = true
            return recoveryKey
        }

        override suspend fun unlockWithVaultPassword(vaultPassword: String) {
            record("unlockWithVaultPassword")
            deviceHoldsKey = true
        }

        override suspend fun unlockWithRecoveryKey(typed: String) {
            record("unlockWithRecoveryKey")
            deviceHoldsKey = true
        }

        /**
         * The two account-card re-wraps. Both hold the rule the engine holds: a
         * device that does not have the vault key has nothing to re-wrap, and
         * neither asks for a current secret.
         */
        var vaultPassword = "a long enough vault password"
        var replacementRecoveryKey = "ZYXW-VTSR-QPNM-KJHG-FEDC-BA98-7654"

        override suspend fun changeVaultPassword(newPassword: String) {
            record("changeVaultPassword")
            if (!deviceHoldsKey) throw HostedException.VaultLocked()
            vaultPassword = newPassword
        }

        override suspend fun newRecoveryKey(): String {
            record("newRecoveryKey")
            if (!deviceHoldsKey) throw HostedException.VaultLocked()
            return replacementRecoveryKey
        }

        /** The pairing this device would show, and how the wait ends. */
        var pairingCode = PairingCode(PAIRING_PAYLOAD, "2026-09-15T20:05:00Z")
        var pairingOutcome = PairingOutcome.PAIRED
        var pairingFailure: HostedException? = null
        var beganPairingAs: String? = null

        /** Set to hold `awaitPairing` open, so a live wait can be cancelled. */
        var pairingGate: CompletableDeferred<Unit>? = null

        override suspend fun beginPairing(deviceName: String): PairingCode {
            record("beginPairing")
            beganPairingAs = deviceName
            return pairingCode
        }

        override suspend fun awaitPairing(): PairingOutcome {
            record("awaitPairing")
            pairingGate?.await()
            pairingFailure?.let {
                pairingFailure = null
                throw it
            }
            if (pairingOutcome == PairingOutcome.PAIRED) deviceHoldsKey = true
            return pairingOutcome
        }

        // Rust's PairingRequest is an opaque handle with no constructor a test
        // can reach — which is the point (a wrong scan has nothing to send). The
        // wizard reaches both of these through `parseScanned` / ScannedPairing,
        // so a test never needs one.
        override fun completePairing(scanned: String) =
            error("the shell parses through parseScanned")

        override suspend fun confirmPairing(request: PairingRequest) =
            error("the shell sends through ScannedPairing")

        override suspend fun signOut(sync: SyncClient) = error("the shell builds the target")

        fun signOutHere() {
            record("signOut")
            signedIn = false
            deviceHoldsKey = false
        }

        private fun record(call: String) {
            calls.add(call)
            nextFailure?.let {
                nextFailure = null
                throw it
            }
        }
    }

    /** The shell, with the browser tab and clipboard replaced by a log. */
    private class StandInShell : HostedSetupShell {
        val openedUrls = mutableListOf<String>()
        var closes = 0
        var clipboard: String? = null
        var shared: String? = null
        val announcements = mutableListOf<String>()

        var reportedName = "Pixel 8"

        override fun deviceName() = reportedName

        /** Set to have the person "come back from the tab" the moment it opens. */
        var dismissImmediately = false
        private var onDismiss: (() -> Unit)? = null

        override fun openAuthTab(url: String, onDismiss: () -> Unit) {
            openedUrls.add(url)
            this.onDismiss = onDismiss
            if (dismissImmediately) onDismiss()
        }

        override fun closeAuthTab() {
            closes += 1
        }

        override fun copyToClipboard(text: String) {
            clipboard = text
        }

        override fun share(text: String) {
            shared = text
        }

        override fun announce(message: LocalizedMessage) {
            announcements.add(message.path)
        }

        /** The person leaving the tab mid-wait. */
        fun leaveTab() = onDismiss?.invoke()
    }

    /**
     * A code the engine has already parsed. The live one wraps Rust's opaque
     * `PairingRequest`; this one carries the same two facts and counts sends,
     * which is the whole question the confirmation dialog exists to answer.
     */
    private class StandInScannedPairing(
        override val deviceName: String = "MacBook Pro",
        override val platform: String = "desktop",
        var failure: Exception? = null,
    ) : ScannedPairing {
        var sends = 0

        override suspend fun send() {
            sends += 1
            failure?.let {
                failure = null
                throw it
            }
        }
    }

    private fun model(
        setup: StandInSetup,
        shell: StandInShell = StandInShell(),
        flow: SignInFlow = SignInFlow.Hosted(sellsSubscriptions = true),
    ) = HostedSetupModel(
        makeSetup = { setup },
        shell = shell,
        signOutEffect = { setup.signOutHere() },
        probe = { flow },
        readMinimumVaultPasswordLength = { 12 },
        log = {},
    )

    private fun model(
        setup: StandInSetup,
        shell: StandInShell,
        scanned: StandInScannedPairing,
        parse: (String) -> ScannedPairing = { scanned },
    ) = HostedSetupModel(
        makeSetup = { setup },
        shell = shell,
        signOutEffect = { setup.signOutHere() },
        probe = { SignInFlow.Hosted(sellsSubscriptions = true) },
        parseScanned = { _, code -> parse(code) },
        readMinimumVaultPasswordLength = { 12 },
        log = {},
    )

    /** A wizard sitting on an unlocked, set-up vault: the account card. */
    private fun unlockedSetup() = StandInSetup().apply {
        signedIn = true
        entitled = true
        vaultHasKeyMaterial = true
        deviceHoldsKey = true
    }

    /** A wizard on the unlock screen: signed in, vault exists, no key here. */
    private fun lockedSetup() = StandInSetup().apply {
        signedIn = true
        entitled = true
        vaultHasKeyMaterial = true
    }

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

    private companion object {
        const val PAIRING_PAYLOAD =
            """{"futo_notes_pairing":1,"id":"pairing-1","name":"Pixel 8","platform":"android"}"""
    }
}

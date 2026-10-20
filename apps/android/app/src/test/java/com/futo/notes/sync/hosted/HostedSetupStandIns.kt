package com.futo.notes.sync.hosted

import com.futo.notes.localization.LocalizedMessage
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
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

// The stand-ins every HostedSetupModel test class drives the wizard against —
// see HostedSetupModelTest for why they derive the step from Rust's four facts.

// ── Stand-ins ────────────────────────────────────────────────────────

/** Rust's `HostedSetup`, as far as the wizard can tell. */
internal class StandInSetup : HostedSetupClientInterface {
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

    override suspend fun connectSync(sync: SyncClient) =
        error("the shell builds the target")

    override suspend fun hasSavedVault(): Boolean {
        record("hasSavedVault")
        return signedIn && deviceHoldsKey
    }

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
internal class StandInShell : HostedSetupShell {
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
internal class StandInScannedPairing(
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

/**
 * What the wizard hands the app when it finishes: the sync it starts, and
 * the sign out it routes through the same manager. Counted, because "once"
 * is the whole question — a second client would leave the first one's live
 * loop running.
 */
internal class StandInSession {
    var connects = 0
    var signOuts = 0
}

/**
 * Where the connect and the account re-read run. `Unconfined` runs them
 * inline as far as they get without really suspending, which is all the way
 * for these stand-ins — so a test reads a settled model rather than racing
 * one. The app uses the screen's own main-thread scope.
 */
internal fun effectScope() = CoroutineScope(Dispatchers.Unconfined)

internal fun model(
    setup: StandInSetup,
    shell: StandInShell = StandInShell(),
    flow: SignInFlow = SignInFlow.Hosted(sellsSubscriptions = true),
    session: StandInSession = StandInSession(),
) = HostedSetupModel(
    makeSetup = { setup },
    shell = shell,
    signOutEffect = {
        session.signOuts += 1
        setup.signOutHere()
    },
    connectEffect = { session.connects += 1 },
    effectScope = effectScope(),
    probe = { flow },
    readMinimumVaultPasswordLength = { 12 },
    log = {},
)

internal fun model(
    setup: StandInSetup,
    shell: StandInShell,
    scanned: StandInScannedPairing,
    session: StandInSession = StandInSession(),
    parse: (String) -> ScannedPairing = { scanned },
) = HostedSetupModel(
    makeSetup = { setup },
    shell = shell,
    signOutEffect = {
        session.signOuts += 1
        setup.signOutHere()
    },
    connectEffect = { session.connects += 1 },
    effectScope = effectScope(),
    probe = { SignInFlow.Hosted(sellsSubscriptions = true) },
    parseScanned = { _, code -> parse(code) },
    readMinimumVaultPasswordLength = { 12 },
    log = {},
)

/** A wizard sitting on an unlocked, set-up vault: the account card. */
internal fun unlockedSetup() = StandInSetup().apply {
    signedIn = true
    entitled = true
    vaultHasKeyMaterial = true
    deviceHoldsKey = true
}

/** A wizard on the unlock screen: signed in, vault exists, no key here. */
internal fun lockedSetup() = StandInSetup().apply {
    signedIn = true
    entitled = true
    vaultHasKeyMaterial = true
}

private const val PAIRING_PAYLOAD =
    """{"futo_notes_pairing":1,"id":"pairing-1","name":"Pixel 8","platform":"android"}"""

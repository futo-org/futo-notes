package com.futo.notes.sync.hosted

import android.content.ActivityNotFoundException
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.futo.notes.localization.LocalizedMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import uniffi.futo_notes_ffi.BillingStatus
import uniffi.futo_notes_ffi.Checkout
import uniffi.futo_notes_ffi.EntitlementOutcome
import uniffi.futo_notes_ffi.HostedException
import uniffi.futo_notes_ffi.HostedSetupClientInterface
import uniffi.futo_notes_ffi.PairingOutcome
import uniffi.futo_notes_ffi.SetupStep
import uniffi.futo_notes_ffi.SignInFlow
import uniffi.futo_notes_ffi.SignInOutcome
import uniffi.futo_notes_ffi.WriteRefusal
import uniffi.futo_notes_ffi.minVaultPasswordLength
import uniffi.futo_notes_ffi.probeSignInFlow

/**
 * Which hosted screen to render.
 *
 * Five of these are Rust's `SetupStep` verbatim. `RECOVERY_KEY` is not a step
 * and deliberately has no Rust variant: it exists only for as long as this
 * object holds the string `createVault` — or, from the account card,
 * `newRecoveryKey` — handed back, and Rust keeps no copy to hand over twice
 * (ADR 0003, decision 3). `CHANGE_VAULT_PASSWORD` is the account card's other
 * detour and is likewise not a step: the wizard is finished and Rust answers
 * `READY` throughout. `LOADING` and `UNAVAILABLE` are this shell's own — the
 * moment before Rust has answered, and a server that does not offer hosted sync
 * at all.
 */
enum class HostedScreen {
    LOADING,
    UNAVAILABLE,
    SIGN_IN,
    SUBSCRIBE,
    CREATE_VAULT,
    RECOVERY_KEY,
    UNLOCK,
    ACCOUNT,
    CHANGE_VAULT_PASSWORD,
}

/** What the sync screen says when the server would refuse a write. */
enum class HostedBanner {
    NONE,
    SYNC_PAUSED,
    VAULT_FULL,
}

/** The three doors on the unlock screen. */
enum class UnlockDoor(val catalogSuffix: String) {
    VAULT_PASSWORD("vaultPassword"),
    SCAN("scan"),
    RECOVERY_KEY("recoveryKey"),
}

/** What the browser tab is currently open for. */
enum class HostedWait {
    SIGN_IN,
    CHECKOUT,
}

/**
 * What the code THIS device is showing is doing, on the scan door of the
 * unlock screen. Every one of these is Rust's answer rendered; nothing in this
 * shell decides a state. [REFUSED] is the narrower case where the relay will
 * not serve the pairing at all — an ordinary decline reaches us as [EXPIRED],
 * because a person who says no on the other device sends nothing.
 */
enum class PairingState {
    IDLE,
    WAITING,
    RECEIVED,
    EXPIRED,
    REFUSED,
}

/** What the scanner is doing on an already-unlocked device. */
enum class ScanPhase {
    CLOSED,

    /** The camera is live, waiting for a code. */
    SCANNING,

    /** A code was read and parsed; the dialog names the device it came from. */
    CONFIRMING,

    /** Send was pressed: the vault key is being sealed and posted. */
    SENDING,

    /** The key is on the relay. The other device collects it. */
    SENT,
}

/**
 * Everything the hosted sync screen renders from, and everything it can do.
 *
 * A direct counterpart of the desktop's `createHostedSyncSettings.svelte.ts`
 * and iOS's `HostedSetupModel.swift`, down to the order of the steps, because
 * the three shells render one state machine and should not have three shapes
 * for it.
 *
 * Every dependency is a parameter so a JVM unit test drives the whole wizard
 * against a stand-in with no Rust — and no native library — behind it.
 */
class HostedSetupModel(
    /**
     * The state machine this wizard renders. Deferred to the first step so a
     * secret store that refuses becomes an on-screen sentence like any other
     * failure, rather than a screen that cannot be built.
     */
    private val makeSetup: () -> HostedSetupClientInterface,
    private val shell: HostedSetupShell,
    /**
     * Signing out needs a handle on this vault to demote what is on disk,
     * exactly as disconnect does. Building that handle is shell work — the
     * engine is handed one, it does not make one.
     */
    private val signOutEffect: suspend (HostedSetupClientInterface) -> Unit,
    /**
     * Started the moment this wizard reaches `READY`: the vault is unlocked, so
     * a sync can run. Every door ends here — a vault password, a recovery key,
     * or a paired device — because all three end with the same two secrets in
     * the same place.
     *
     * Run outside the step, because it is a whole sync cycle and the account
     * card must not wait behind one. Fired once per reached session (see
     * `connectStarted`), and idempotent beyond that anyway: Rust rebuilds the
     * same session from the same facts.
     */
    private val connectEffect: suspend (HostedSetupClientInterface) -> Unit,
    /**
     * Where the connect and the account re-read run. The screen's own scope in
     * the app; a test hands it one it can drain.
     */
    private val effectScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
    /**
     * Reads the server's capability document. A parameter only because it is
     * the one thing [load] does that talks to the network before there is a
     * state machine to talk through.
     */
    private val probe: suspend (String) -> SignInFlow = { probeSignInFlow(it) },
    /**
     * Reads what the camera returned. A parameter because a JVM test has
     * neither a camera nor a native library, so the string has to be
     * injectable — everything downstream of it is the same code either way
     * (ADR 0003, decision 12). The live one is Rust's `complete_pairing`,
     * which parses and nothing else.
     */
    private val parseScanned: (HostedSetupClientInterface, String) -> ScannedPairing =
        { setup, code -> RustScannedPairing(setup.completePairing(code), setup) },
    /** Rust's own minimum, so the Continue button and the engine agree. */
    private val readMinimumVaultPasswordLength: () -> Int = {
        minVaultPasswordLength().toInt()
    },
    private val log: (String) -> Unit = { android.util.Log.e("FutoHosted", it) },
) {
    var screen by mutableStateOf(HostedScreen.LOADING)
        private set
    var busy by mutableStateOf(false)
        private set
    var waiting by mutableStateOf<HostedWait?>(null)
        private set
    var errorMessage by mutableStateOf<LocalizedMessage?>(null)
        private set

    /** Where sign-in will happen, so a debug override is never invisible. */
    var serverUrl by mutableStateOf("")
        private set
    var email by mutableStateOf("")
        private set
    var billing by mutableStateOf<BillingStatus?>(null)
        private set

    /**
     * Non-null only while the save-it-now screen is up. Nothing persists it,
     * nothing else reads it, and [continueAfterRecoveryKey] is the only thing
     * that clears it. Rust hands it over once and keeps no copy, so once this is
     * null there is no way to show it again.
     */
    var recoveryKey by mutableStateOf<String?>(null)
        private set

    /** True when the key on that screen replaced one a person already had. */
    var recoveryKeyReplaced by mutableStateOf(false)
        private set

    var minimumVaultPasswordLength by mutableStateOf(12)
        private set

    /**
     * The show side of pairing: this device is the new one, drawing a code for
     * an unlocked device to read.
     */
    var pairing by mutableStateOf(PairingState.IDLE)
        private set

    /**
     * The payload to draw, straight from Rust. Non-null only while a live code
     * is on screen.
     */
    var pairingPayload by mutableStateOf<String?>(null)
        private set

    /** RFC 3339, the relay's own deadline — what the countdown describes. */
    var pairingExpiresAt by mutableStateOf<String?>(null)
        private set

    /** The scan side: this device is the unlocked one, reading someone else's code. */
    var scanPhase by mutableStateOf(ScanPhase.CLOSED)
        private set

    /**
     * The parsed code waiting on a confirmation. Holding one is what makes Send
     * possible at all; nothing else in this shell can produce one.
     */
    var scannedPairing by mutableStateOf<ScannedPairing?>(null)
        private set

    var recoveryKeySaved by mutableStateOf(false)

    /**
     * Which door the unlock screen is showing. Set through [chooseDoor] rather
     * than written directly, because leaving the scan door has to stop a live
     * pairing wait — which only this object can do.
     */
    var unlockDoor by mutableStateOf(UnlockDoor.VAULT_PASSWORD)
        private set

    var selfHostedOpen by mutableStateOf(false)

    private var setup: HostedSetupClientInterface? = null

    /**
     * Whether the LAST completed cycle's writes were refused, and which way.
     *
     * Rust decides it (`futo_notes_sync::WriteRefusal`, projected onto
     * `SyncSummary.writeRefusal`); [com.futo.notes.SyncManager] holds the newest
     * answer because it outlives this screen, and `HostedSyncSections` hands it
     * over. Never a latch: every completed cycle writes its own answer here,
     * null included.
     */
    var writeRefusal by mutableStateOf<WriteRefusal?>(null)

    /**
     * Whether the connect for the session this wizard is looking at has been
     * started. Reset when it observes a signed-out device, so signing back in
     * starts the next session's sync.
     */
    private var connectStarted = false

    /**
     * Two ways to learn the same thing, and a banner either of them earns.
     *
     * [billing] is a reading of the account, taken when this screen opened.
     * [writeRefusal] is the last cycle's own answer — the 402 or 507 the server
     * actually returned — which arrives the moment the refused cycle ends and
     * needs no billing call at all. Neither is a latch.
     *
     * Sync paused wins over a full vault, whichever input says so: a lapsed
     * subscription refuses the write whatever the quota says, so telling
     * someone to buy more storage would be the wrong instruction.
     *
     * Nothing shows before the wizard has finished — which is also what keeps
     * one account's refusal off the sign-in screen of the next.
     *
     * The twin of `hostedBanner.ts` and iOS `HostedSetupModel.banner`
     * (`hosted-sync-banner-rule` in scripts/drift-registry.json).
     */
    val banner: HostedBanner
        get() {
            if (screen != HostedScreen.ACCOUNT) return HostedBanner.NONE
            val status = billing
            if (writeRefusal == WriteRefusal.SUBSCRIPTION_REQUIRED || status?.entitled == false) {
                return HostedBanner.SYNC_PAUSED
            }
            if (writeRefusal == WriteRefusal.QUOTA_EXCEEDED) return HostedBanner.VAULT_FULL
            if (status != null &&
                status.storageQuotaBytes > 0uL &&
                status.bytesUsed >= status.storageQuotaBytes
            ) {
                return HostedBanner.VAULT_FULL
            }
            return HostedBanner.NONE
        }

    suspend fun load() = step { setup ->
        serverUrl = setup.serverUrl()
        if (probe(serverUrl) !is SignInFlow.Hosted) {
            // An old deployment, or the hosted name not pointed at one yet.
            // Saying so beats opening a tab onto a route that is not there.
            screen = HostedScreen.UNAVAILABLE
            return@step
        }
        minimumVaultPasswordLength = readMinimumVaultPasswordLength()
        readStep(setup)
    }

    suspend fun signIn() = step { setup ->
        val handoff = setup.beginSignIn()
        waiting = HostedWait.SIGN_IN
        shell.openAuthTab(handoff.url) { setup.cancelWait() }
        val outcome = setup.awaitSignIn(handoff)
        waiting = null
        shell.closeAuthTab()
        when (outcome) {
            // No error and no half state.
            is SignInOutcome.Cancelled -> Unit
            is SignInOutcome.Expired ->
                errorMessage = LocalizedMessage("sync.hosted.errors.signInExpired")
            is SignInOutcome.SignedIn -> readStep(setup)
        }
    }

    /** The person pressed Cancel on the screen rather than leaving the tab. */
    fun cancelWaiting() {
        setup?.cancelWait()
        shell.closeAuthTab()
        waiting = null
    }

    suspend fun subscribe() = step { setup ->
        val checkout = setup.beginCheckout()
        if (checkout !is Checkout.Open) {
            readStep(setup)
            return@step
        }
        waiting = HostedWait.CHECKOUT
        shell.openAuthTab(checkout.url) { setup.cancelWait() }
        val outcome = setup.awaitEntitled()
        waiting = null
        shell.closeAuthTab()
        when (outcome) {
            is EntitlementOutcome.Cancelled -> Unit
            is EntitlementOutcome.GaveUp -> {
                billing = outcome.status
                errorMessage = LocalizedMessage("sync.hosted.errors.checkoutGaveUp")
            }
            is EntitlementOutcome.Entitled -> readStep(setup)
        }
    }

    suspend fun createVault(vaultPassword: String) = step { setup ->
        recoveryKey = setup.createVault(vaultPassword)
        recoveryKeyReplaced = false
        recoveryKeySaved = false
        screen = HostedScreen.RECOVERY_KEY
    }

    /**
     * Opens the new-password screen. No round trip and no current secret asked:
     * this device holds the vault key already, and a device paired by QR never
     * knew the old password (ADR 0003, decision 10).
     */
    fun beginChangeVaultPassword() {
        errorMessage = null
        screen = HostedScreen.CHANGE_VAULT_PASSWORD
    }

    /**
     * Re-wraps the password envelope and goes back to the account card.
     *
     * Rust re-wraps the same vault key, so every other device carries on with
     * what it already holds and is never told anything happened (parent spec
     * user story 33). A [HostedException.VaultKeyChangedElsewhere] leaves this
     * screen up with that sentence on it, because pressing the button again is
     * the whole remedy.
     */
    suspend fun changeVaultPassword(newPassword: String) = step { setup ->
        setup.changeVaultPassword(newPassword)
        shell.announce(LocalizedMessage("sync.hosted.vaultPassword.change.changed"))
        readStep(setup)
    }

    /**
     * Issues a new recovery key and shows it on the same save screen the wizard
     * uses — the old one has stopped working by the time it appears.
     */
    suspend fun newRecoveryKey() = step { setup ->
        recoveryKey = setup.newRecoveryKey()
        recoveryKeyReplaced = true
        recoveryKeySaved = false
        screen = HostedScreen.RECOVERY_KEY
    }

    /** Leaves an account-card detour without doing anything. */
    suspend fun backToAccount() = step { setup -> readStep(setup) }

    fun copyRecoveryKey() {
        val key = recoveryKey ?: return
        shell.copyToClipboard(key)
        shell.announce(LocalizedMessage("sync.hosted.recoveryKey.copied"))
    }

    /** Shares the key and nothing else, so it pastes straight into unlock. */
    fun shareRecoveryKey() {
        val key = recoveryKey ?: return
        shell.share(key)
    }

    suspend fun continueAfterRecoveryKey() {
        recoveryKey = null
        recoveryKeyReplaced = false
        recoveryKeySaved = false
        step { setup -> readStep(setup) }
    }

    suspend fun unlockWithPassword(vaultPassword: String) = step { setup ->
        setup.unlockWithVaultPassword(vaultPassword)
        readStep(setup)
    }

    suspend fun unlockWithRecoveryKey(typed: String) = step { setup ->
        setup.unlockWithRecoveryKey(typed)
        readStep(setup)
    }

    /**
     * Moves the unlock screen to another door, stopping a live pairing wait on
     * the way out. A code that is already on the relay cannot be withdrawn, so
     * leaving abandons it rather than resuming it.
     */
    fun chooseDoor(door: UnlockDoor) {
        if (unlockDoor == UnlockDoor.SCAN && door != UnlockDoor.SCAN) cancelPairing()
        unlockDoor = door
    }

    /**
     * Opens a pairing and shows its code until the other device answers.
     *
     * One call covers the whole wait: Rust mints the one-time keypair,
     * publishes the public half to the relay, and polls for the sealed vault
     * key until the relay's own five minutes are up. What comes back decides
     * the state, which is why nothing here has its own timer — the countdown on
     * screen only describes that deadline, it does not enforce it.
     */
    suspend fun showPairingCode() = step { setup ->
        pairing = PairingState.IDLE
        pairingPayload = null
        val code = setup.beginPairing(shell.deviceName())
        pairingPayload = code.payload
        pairingExpiresAt = code.expiresAt
        pairing = PairingState.WAITING
        try {
            val outcome = setup.awaitPairing()
            pairingPayload = null
            if (outcome == PairingOutcome.CANCELLED) {
                pairing = PairingState.IDLE
                return@step
            }
            // The key arrived and is kept: this device is unlocked. Said here
            // rather than after the step read, so the code's disappearance is
            // explained while that read is in flight.
            pairing = PairingState.RECEIVED
            readStep(setup)
        } catch (e: HostedException) {
            pairingPayload = null
            when (e) {
                // A person who declined on the other device sent nothing, so
                // this is also what declining looks like from here. The copy
                // says so rather than claiming to know which happened.
                is HostedException.PairingExpired -> pairing = PairingState.EXPIRED
                is HostedException.PairingRefused,
                is HostedException.PairingAlreadyKeyed,
                -> pairing = PairingState.REFUSED
                else -> {
                    pairing = PairingState.IDLE
                    throw e
                }
            }
        }
    }

    /**
     * Stops waiting and puts the three doors back. Deliberately outside [step]:
     * the wait it is cancelling is what holds `busy`.
     */
    fun cancelPairing() {
        if (pairing == PairingState.WAITING) setup?.cancelWait()
        pairing = PairingState.IDLE
        pairingPayload = null
        pairingExpiresAt = null
    }

    /** Opens the camera on an unlocked device (parent spec user story 15). */
    fun openScanner() {
        errorMessage = null
        scannedPairing = null
        scanPhase = ScanPhase.SCANNING
    }

    /**
     * One code, from the camera or from a test. Parsing touches no network, no
     * secret store, and no vault key — all it answers is the name to put on the
     * confirmation dialog.
     */
    suspend fun readScannedCode(code: String) = step { setup ->
        scannedPairing = parseScanned(setup, code)
        scanPhase = ScanPhase.CONFIRMING
    }

    /**
     * The confirmation (parent spec user story 16). This is the only thing in
     * the app that sends a vault key anywhere.
     */
    suspend fun sendVaultKey() {
        val scanned = scannedPairing ?: return
        step {
            scanPhase = ScanPhase.SENDING
            try {
                scanned.send()
            } catch (e: Exception) {
                // A refused or already-answered pairing cannot be retried, and
                // a locked device has nothing to give: either way the next
                // useful move is a fresh code, so the camera goes back on with
                // the reason on screen.
                scannedPairing = null
                scanPhase = ScanPhase.SCANNING
                throw e
            }
            scanPhase = ScanPhase.SENT
        }
    }

    /** Said no on the confirmation dialog. Nothing was sent, and nothing is kept. */
    fun cancelConfirmation() {
        scannedPairing = null
        errorMessage = null
        scanPhase = ScanPhase.SCANNING
    }

    fun closeScanner() {
        scannedPairing = null
        scanPhase = ScanPhase.CLOSED
    }

    suspend fun manageSubscription() = step { setup ->
        shell.openAuthTab(setup.billingPortal()) {}
    }

    /** Called only after the confirmation dialog the account card owns. */
    suspend fun signOut() {
        cancelPairing()
        closeScanner()
        recoveryKey = null
        recoveryKeyReplaced = false
        signOutStep()
    }

    private suspend fun signOutStep() = step { setup ->
        signOutEffect(setup)
        readStep(setup)
    }

    /**
     * Asks Rust which screen we are on, and reads what that screen needs.
     *
     * This is the ONLY thing that decides the wizard's position. Nothing here
     * remembers a step, which is what makes quitting halfway and reopening land
     * on the right screen rather than on a saved cursor that can disagree with
     * the server (ADR 0003, decision 3).
     */
    private suspend fun readStep(setup: HostedSetupClientInterface) {
        when (setup.currentStep()) {
            SetupStep.SIGN_IN -> {
                // Nothing below applies before there is a session, and asking
                // for it would be a round trip that answers "not signed in". A
                // signed-out device also has no session to sync: the next one
                // that reaches READY is a new one and starts its own.
                connectStarted = false
                email = ""
                billing = null
                screen = HostedScreen.SIGN_IN
                return
            }
            SetupStep.SUBSCRIBE -> screen = HostedScreen.SUBSCRIBE
            SetupStep.CREATE_VAULT -> screen = HostedScreen.CREATE_VAULT
            SetupStep.UNLOCK -> screen = HostedScreen.UNLOCK
            SetupStep.READY -> screen = HostedScreen.ACCOUNT
        }
        email = setup.session()?.email ?: ""
        billing = setup.billingStatus()
        if (screen == HostedScreen.ACCOUNT) startConnect(setup)
    }

    /**
     * The end of the wizard is a running sync, not a set-up vault that sits
     * there. Started once per reached session — the first read that lands on
     * `READY`, which is also the read every door ends with — and left to run on
     * its own, because a sync cycle is not something the account card should
     * wait behind.
     */
    private fun startConnect(setup: HostedSetupClientInterface) {
        if (connectStarted) return
        connectStarted = true
        effectScope.launch {
            runCatching { connectEffect(setup) }.onFailure { log("connect failed: $it") }
            refreshBilling()
        }
    }

    /**
     * Re-reads the account after that first cycle, so the usage on the card is
     * what this vault now weighs rather than what it weighed before anything
     * had been uploaded. A read that fails leaves the card as it was: the figure
     * on it is stale, not wrong, and blanking it would say less.
     */
    private suspend fun refreshBilling() {
        val current = setup ?: return
        if (screen != HostedScreen.ACCOUNT) return
        runCatching { current.billingStatus() }.getOrNull()?.let { billing = it }
    }

    /**
     * Runs one step, reporting whatever it fails with as a sentence. Nothing
     * else here catches, so no failure can leave the screen busy forever.
     */
    private suspend fun step(work: suspend (HostedSetupClientInterface) -> Unit) {
        if (busy) return
        busy = true
        errorMessage = null
        try {
            val client = setup ?: makeSetup().also { setup = it }
            work(client)
        } catch (e: ActivityNotFoundException) {
            // No Custom Tabs provider AND no browser at all. Named here rather
            // than in `hostedErrorMessage`, which is a per-shell mirror of one
            // vocabulary and must not grow an Android-only variant.
            log("no browser to open: $e")
            errorMessage = LocalizedMessage("sync.hosted.errors.noBrowser")
        } catch (e: Exception) {
            log("step failed: $e")
            errorMessage = hostedErrorMessage(e)
        }
        busy = false
        waiting = null
    }
}

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
    internal val shell: HostedSetupShell,
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
    internal val parseScanned: (HostedSetupClientInterface, String) -> ScannedPairing =
        { setup, code -> RustScannedPairing(setup.completePairing(code), setup) },
    /** Rust's own minimum, so the Continue button and the engine agree. */
    private val readMinimumVaultPasswordLength: () -> Int = {
        minVaultPasswordLength().toInt()
    },
    private val log: (String) -> Unit = { android.util.Log.e("FutoHosted", it) },
) {
    var screen by mutableStateOf(HostedScreen.LOADING)
        internal set
    var busy by mutableStateOf(false)
        private set
    var waiting by mutableStateOf<HostedWait?>(null)
        private set
    var errorMessage by mutableStateOf<LocalizedMessage?>(null)
        internal set

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
        internal set

    /** True when the key on that screen replaced one a person already had. */
    var recoveryKeyReplaced by mutableStateOf(false)
        internal set

    var minimumVaultPasswordLength by mutableStateOf(12)
        private set

    /**
     * The show side of pairing: this device is the new one, drawing a code for
     * an unlocked device to read.
     */
    var pairing by mutableStateOf(PairingState.IDLE)
        internal set

    /**
     * The payload to draw, straight from Rust. Non-null only while a live code
     * is on screen.
     */
    var pairingPayload by mutableStateOf<String?>(null)
        internal set

    /** RFC 3339, the relay's own deadline — what the countdown describes. */
    var pairingExpiresAt by mutableStateOf<String?>(null)
        internal set

    /** The scan side: this device is the unlocked one, reading someone else's code. */
    var scanPhase by mutableStateOf(ScanPhase.CLOSED)
        internal set

    /**
     * The parsed code waiting on a confirmation. Holding one is what makes Send
     * possible at all; nothing else in this shell can produce one.
     */
    var scannedPairing by mutableStateOf<ScannedPairing?>(null)
        internal set

    var recoveryKeySaved by mutableStateOf(false)

    /**
     * Which door the unlock screen is showing. Set through [chooseDoor] rather
     * than written directly, because leaving the scan door has to stop a live
     * pairing wait — which only this object can do.
     */
    var unlockDoor by mutableStateOf(UnlockDoor.VAULT_PASSWORD)
        internal set

    var selfHostedOpen by mutableStateOf(false)

    internal var setup: HostedSetupClientInterface? = null

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
    internal suspend fun readStep(setup: HostedSetupClientInterface) {
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
    internal suspend fun step(work: suspend (HostedSetupClientInterface) -> Unit) {
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

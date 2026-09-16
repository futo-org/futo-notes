package com.futo.notes.sync.hosted

import android.content.ActivityNotFoundException
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.futo.notes.localization.LocalizedMessage
import uniffi.futo_notes_ffi.BillingStatus
import uniffi.futo_notes_ffi.Checkout
import uniffi.futo_notes_ffi.EntitlementOutcome
import uniffi.futo_notes_ffi.HostedSetupClientInterface
import uniffi.futo_notes_ffi.SetupStep
import uniffi.futo_notes_ffi.SignInFlow
import uniffi.futo_notes_ffi.SignInOutcome
import uniffi.futo_notes_ffi.minVaultPasswordLength
import uniffi.futo_notes_ffi.probeSignInFlow

/**
 * Which hosted screen to render.
 *
 * Five of these are Rust's `SetupStep` verbatim. `RECOVERY_KEY` is not a step
 * and deliberately has no Rust variant: it exists only for as long as this
 * object holds the string `createVault` handed back, which happens exactly once
 * per vault because a second create is refused (ADR 0003, decision 3).
 * `LOADING` and `UNAVAILABLE` are this shell's own — the moment before Rust has
 * answered, and a server that does not offer hosted sync at all.
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
     * Reads the server's capability document. A parameter only because it is
     * the one thing [load] does that talks to the network before there is a
     * state machine to talk through.
     */
    private val probe: suspend (String) -> SignInFlow = { probeSignInFlow(it) },
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

    var minimumVaultPasswordLength by mutableStateOf(12)
        private set

    var recoveryKeySaved by mutableStateOf(false)
    var unlockDoor by mutableStateOf(UnlockDoor.VAULT_PASSWORD)
    var selfHostedOpen by mutableStateOf(false)

    private var setup: HostedSetupClientInterface? = null

    /**
     * A banner is a fact about the account, read the same way the account card
     * reads everything else. Sync paused wins over a full vault: a lapsed
     * subscription refuses the write whatever the quota says, so telling
     * someone to buy more storage would be the wrong instruction.
     */
    val banner: HostedBanner
        get() {
            if (screen != HostedScreen.ACCOUNT) return HostedBanner.NONE
            val status = billing ?: return HostedBanner.NONE
            if (!status.entitled) return HostedBanner.SYNC_PAUSED
            if (status.storageQuotaBytes > 0uL && status.bytesUsed >= status.storageQuotaBytes) {
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
        recoveryKeySaved = false
        screen = HostedScreen.RECOVERY_KEY
    }

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

    suspend fun manageSubscription() = step { setup ->
        shell.openAuthTab(setup.billingPortal()) {}
    }

    /** Called only after the confirmation dialog the account card owns. */
    suspend fun signOut() = step { setup ->
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
                // for it would be a round trip that answers "not signed in".
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

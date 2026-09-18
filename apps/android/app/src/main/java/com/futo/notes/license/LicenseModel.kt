package com.futo.notes.license

import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.futo.notes.BuildConfig
import com.futo.notes.localization.LocalizedMessage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import uniffi.futo_notes_ffi.LicenseAcceptance
import uniffi.futo_notes_ffi.LicenseAction
import uniffi.futo_notes_ffi.LicenseException
import uniffi.futo_notes_ffi.LicenseLinkOutcome
import uniffi.futo_notes_ffi.LicenseLinks
import uniffi.futo_notes_ffi.LicenseStatus
import uniffi.futo_notes_ffi.LicensePlatform
import uniffi.futo_notes_ffi.LicenseView
import uniffi.futo_notes_ffi.licenseEnterKey
import uniffi.futo_notes_ffi.licenseEvaluate
import uniffi.futo_notes_ffi.licenseHandleDeepLink
import uniffi.futo_notes_ffi.licenseLinks
import uniffi.futo_notes_ffi.licenseRowActions

/**
 * The Android shell's license state.
 *
 * Read once at startup and updated from the result of each action — never
 * re-verified per render and never per keystroke (M5). Every rule behind it
 * lives in `futo-notes-license` and reaches here through the UniFFI
 * projection: this object owns only storage, the toast path, and the fact that
 * this build is Android. Mirrors iOS `LicenseModel.swift` and the desktop
 * projection's `src/features/license/license.svelte.ts`.
 */
class LicenseModel(
    private val storage: LicenseStorage,
    private val bundleId: String,
    /**
     * The build-time store-posture flag (docs/spec/license.md § Store posture),
     * per flavor in `app/build.gradle.kts`. A constructor parameter rather than
     * a direct read of the constant so both of its values are exercised by
     * tests without a build flip.
     */
    private val linkOut: Boolean = BuildConfig.LICENSE_LINK_OUT,
    private val enterLicenseKey: suspend (String, String) -> LicenseAcceptance = { input, id ->
        licenseEnterKey(input, id)
    },
) {
    /**
     * `null` until [load] has read the stored pair and Rust has judged it.
     *
     * The shell renders before that (M1): reading preferences is disk, so it
     * happens off the main thread and lands reactively. A row that does not yet
     * know says nothing, rather than flashing "Unlicensed" at a licensed user
     * and correcting itself — the same loading-is-not-empty distinction
     * `hasBootstrapped` draws for the note list.
     */
    var view by mutableStateOf<LicenseView?>(null)
        private set

    /** True only while the one activation request is in flight. */
    var busy by mutableStateOf(false)
        private set

    /**
     * Moments this device *became* licensed, so the plate can mark the occasion.
     * Deliberately driven from [apply] and not from [load]: launching an app
     * that was already licensed is not an activation and must not set anything
     * off.
     */
    var activations by mutableStateOf(0)
        private set

    /**
     * How many of those have been marked. A celebration is a MOMENT, not a
     * state: counting activations alone put on a celebration every time Settings
     * was opened after a removal, because the count stayed at 1 (@justin
     * 2026-09-18).
     */
    private var celebratedActivations by mutableStateOf(0)

    /**
     * An activation that nothing has celebrated yet. It is a DEBT the plate
     * collects rather than an event it has to be listening for, so a license
     * that arrives by deep link while Settings is closed still gets its moment
     * the first time the plate is opened — and gets it exactly once.
     */
    val activationToCelebrate: Boolean get() = activations > celebratedActivations

    /** Spends the debt above. Idempotent. */
    fun markCelebrated() {
        celebratedActivations = activations
    }

    /**
     * The Buy / Renew and "Lost your key?" destinations, from Rust, so no shell
     * hardcodes a URL and all three platforms agree.
     *
     * `by lazy` so constructing the model touches no FFI: the activity builds
     * it during `onCreate`, and the first native call would load the shared
     * library on the main thread there (M1). Settings is where these are read.
     */
    val links: LicenseLinks by lazy { licenseLinks(LicensePlatform.ANDROID, bundleId) }

    /**
     * How a message reaches the user. Assigned by the activity so the license
     * module never has to know which toast is on screen; the strings are
     * catalog paths, because copy is `languages/en.json`'s (§5).
     *
     * Unlike iOS — where SwiftUI can deliver a launch URL before the banner
     * exists, so the message has to be parked — the activity assigns this in
     * `onCreate` and only applies a link after the first composition, so there
     * is always somewhere to deliver to. [announce] still refuses to lose a
     * message silently if that order is ever broken (M11).
     */
    var showMessage: ((LocalizedMessage) -> Unit)? = null

    /**
     * Whether an outcome has already replaced the launch state. A link can be
     * applied before [load]'s disk read comes back, and the stored pair must
     * not then overwrite the license the user just activated.
     */
    private var settled = false
    private var stateRevision = 0

    /**
     * Reads the stored license and evaluates it. Call it un-awaited from the
     * activity: the disk read is on IO and the answer lands reactively, so
     * nothing about the shell waits for it (M1).
     */
    suspend fun load() = applyEvaluated(
        // The read AND the signature check are both off the main thread: one is
        // disk, the other is JNI plus an RSA verify, and neither belongs on the
        // thread that is painting the shell (M1).
        withContext(Dispatchers.IO) { licenseEvaluate(storage.read(), bundleId) },
    )

    /**
     * What [load] does once the disk has answered, as its own step so the
     * ordering hazard can be tested without racing a real read: what was on
     * disk must NOT overwrite a license that arrived while that read was in
     * flight, or a cold-start link would be applied and then silently undone by
     * whatever it replaced.
     */
    internal fun applyEvaluated(evaluated: LicenseView) {
        if (settled) return
        view = evaluated
    }

    /** Which controls the row offers, in the order Rust puts them in. */
    fun actions(): List<LicenseAction> =
        view?.let { licenseRowActions(it.status, linkOut) } ?: emptyList()

    /**
     * Recognise the input, activate it if it was a bare key, verify, and store
     * — one Rust call. The shell never sequences activate-then-verify (§4.6).
     * Answers whether a license was accepted, so the field can close itself.
     */
    suspend fun enterKey(input: String): Boolean {
        if (busy) return false
        busy = true
        val startingRevision = stateRevision
        try {
            val acceptance = enterLicenseKey(input, bundleId)
            if (startingRevision != stateRevision) return false
            apply(acceptance)
            return true
        } catch (error: LicenseException) {
            // One outcome, one message. A key the endpoint does not know and a
            // pair that does not verify share "isn't valid": the user is never
            // told which (docs/spec/license.md § Entering a key).
            announce(
                when (error) {
                    is LicenseException.Invalid -> LocalizedMessage("license.keyInvalid")
                    is LicenseException.Offline -> LocalizedMessage("license.offline")
                },
            )
            return false
        } catch (cancellation: kotlinx.coroutines.CancellationException) {
            // The caller's scope went away (the screen left). Not a failure of
            // the key, and never a message — rethrow so the coroutine machinery
            // sees the cancellation it is waiting for.
            throw cancellation
        } catch (unexpected: Exception) {
            // Not one of the two specified failures — a bug, not a bad key. The
            // user still gets the fail-safe message (nothing was stored), but it
            // must not vanish silently (M11).
            Log.w(LICENSE_LOG_TAG, "unexpected failure entering a key", unexpected)
            announce(LocalizedMessage("license.keyInvalid"))
            return false
        } finally {
            busy = false
        }
    }

    /**
     * One delivered `futonotes://` URL, from a cold start or a running app.
     *
     * A URL at any other host or path is ignored **silently** — that verdict is
     * Rust's, so this method cannot accidentally toast for someone else's link.
     */
    fun handle(url: String) {
        when (val outcome = licenseHandleDeepLink(url, bundleId)) {
            is LicenseLinkOutcome.Ignored -> return
            is LicenseLinkOutcome.Accepted -> apply(outcome.acceptance)
            // A link that fails says so as a *link*: the user never typed a key.
            is LicenseLinkOutcome.Rejected -> announce(LocalizedMessage("license.linkInvalid"))
        }
    }

    /**
     * Returns the device to Unlicensed. No confirmation — it is reversible by
     * re-entering the key — and idempotent.
     */
    fun remove() {
        storage.clear()
        settled = true
        stateRevision += 1
        view = licenseEvaluate(null, bundleId)
    }

    /**
     * Wiped by Full reset like every other preference (settings.md, Danger
     * zone). Deliberately silent: the user is already looking at a reset.
     */
    fun clearForFullReset() = remove()

    private fun announce(message: LocalizedMessage) {
        val destination = showMessage
        if (destination == null) {
            // The activity wires a destination in onCreate and applies links
            // only after the first composition, so this cannot happen in the
            // shipping order — which is exactly why it must be loud rather than
            // a silently swallowed toast if that order ever changes (M11).
            Log.w(LICENSE_LOG_TAG, "no destination for ${message.path}; the message was dropped")
            return
        }
        destination(message)
    }

    private fun apply(acceptance: LicenseAcceptance) {
        // Storing is the shell's half of the atomic workflow: what Rust
        // accepted is persisted verbatim, and the state it returned is what the
        // row renders — no re-read, no second verdict.
        storage.write(acceptance.pair)
        settled = true
        stateRevision += 1
        // Only the CROSSING counts. Re-entering a key you already hold leaves
        // the state at licensed and is not a second activation.
        if (acceptance.view.status == LicenseStatus.LICENSED &&
            view?.status != LicenseStatus.LICENSED
        ) {
            activations += 1
        }
        view = acceptance.view
        announce(LocalizedMessage("license.activated"))
        if (BuildConfig.DEBUG) Log.i(LICENSE_LOG_TAG, "license applied: ${acceptance.view.status}")
    }
}

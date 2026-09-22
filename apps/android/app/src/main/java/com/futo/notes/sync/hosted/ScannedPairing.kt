package com.futo.notes.sync.hosted

import uniffi.futo_notes_ffi.HostedSetupClientInterface
import uniffi.futo_notes_ffi.PairingRequest

/**
 * A pairing code the engine has already parsed, and the one way to answer it.
 *
 * Rust's `PairingRequest` is an opaque handle Kotlin cannot build from a
 * scanned string, and `confirm_pairing` is the only call that takes one — that
 * is what makes the confirmation dialog a real gate rather than a convention,
 * because a wrong scan has nothing to send (ADR 0003, decision 5). This
 * interface keeps that shape while giving the wizard something a JVM test can
 * hand it, since no unit test has a camera or a native library.
 *
 * Nothing here carries a vault key: [send] is Rust sealing this device's key to
 * the scanned public key and posting it to the relay.
 */
interface ScannedPairing {
    /**
     * What the new device calls itself. Self-reported by that device and shown
     * verbatim on the confirmation dialog.
     */
    val deviceName: String

    /** `ios`, `android`, or `desktop`. */
    val platform: String

    /** The confirm step. The only call in the app that sends a vault key. */
    suspend fun send()
}

/**
 * The live one: Rust's parsed request, plus the state machine that will seal
 * and post to it. The request never leaves this object, so nothing above it
 * ever holds the pairing id or the public key.
 */
class RustScannedPairing(
    private val request: PairingRequest,
    private val setup: HostedSetupClientInterface,
) : ScannedPairing {
    override val deviceName: String = request.deviceName()
    override val platform: String = request.platform()

    override suspend fun send() = setup.confirmPairing(request)
}

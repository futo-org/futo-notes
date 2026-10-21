package com.futo.notes.sync.hosted

import uniffi.futo_notes_ffi.HostedException
import uniffi.futo_notes_ffi.PairingOutcome

/**
 * Opens a pairing and shows its code until the other device answers.
 *
 * One call covers the whole wait: Rust mints the one-time keypair,
 * publishes the public half to the relay, and polls for the sealed vault
 * key until the relay's own five minutes are up. What comes back decides
 * the state, which is why nothing here has its own timer — the countdown on
 * screen only describes that deadline, it does not enforce it.
 */
suspend fun HostedSetupModel.showPairingCode() = step { setup ->
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
 * the wait it is canceling is what holds `busy`.
 */
fun HostedSetupModel.cancelPairing() {
    if (pairing == PairingState.WAITING) setup?.cancelWait()
    pairing = PairingState.IDLE
    pairingPayload = null
    pairingExpiresAt = null
}

/** Opens the camera on an unlocked device (parent spec user story 15). */
fun HostedSetupModel.openScanner() {
    errorMessage = null
    scannedPairing = null
    scanPhase = ScanPhase.SCANNING
}

/**
 * One code, from the camera or from a test. Parsing touches no network, no
 * secret store, and no vault key — all it answers is the name to put on the
 * confirmation dialog.
 */
suspend fun HostedSetupModel.readScannedCode(code: String) = step { setup ->
    scannedPairing = parseScanned(setup, code)
    scanPhase = ScanPhase.CONFIRMING
}

/**
 * The confirmation (parent spec user story 16). This is the only thing in
 * the app that sends a vault key anywhere.
 */
suspend fun HostedSetupModel.sendVaultKey() {
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
fun HostedSetupModel.cancelConfirmation() {
    scannedPairing = null
    errorMessage = null
    scanPhase = ScanPhase.SCANNING
}

fun HostedSetupModel.closeScanner() {
    scannedPairing = null
    scanPhase = ScanPhase.CLOSED
}

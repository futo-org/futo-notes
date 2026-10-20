package com.futo.notes.sync.hosted

import uniffi.futo_notes_ffi.SetupStep

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

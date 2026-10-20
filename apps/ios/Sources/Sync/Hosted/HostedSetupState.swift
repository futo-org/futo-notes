import Foundation

/// Which hosted screen to render.
///
/// Five of these are Rust's `SetupStep` verbatim. `recoveryKey` is not a step
/// and deliberately has no Rust variant: it exists only for as long as this
/// object holds the string `createVault` — or, from the account card,
/// `newRecoveryKey` — handed back, and Rust keeps no copy to hand over twice
/// (ADR 0003, decision 3). `changeVaultPassword` is the account card's other
/// detour and is likewise not a step: the wizard is finished and Rust answers
/// `ready` throughout. `loading` and `unavailable` are this shell's own — the
/// moment before Rust has answered, and a server that does not offer hosted
/// sync at all.
enum HostedScreen {
    case loading
    case unavailable
    case signIn
    case subscribe
    case createVault
    case recoveryKey
    case unlock
    case account
    case changeVaultPassword
}

/// What the sync screen says when the server would refuse a write.
enum HostedBanner {
    case none
    case syncPaused
    case vaultFull
}

/// The three doors on the unlock screen.
enum UnlockDoor: String, CaseIterable, Identifiable {
    case vaultPassword
    case scan
    case recoveryKey

    var id: String { rawValue }
}

/// What the auth sheet is currently open for.
enum HostedWait {
    case signIn
    case checkout
}

/// What the code THIS device is showing is doing, on the scan door of the
/// unlock screen. Every one of these is Rust's answer rendered; nothing in this
/// shell decides a state. `refused` is the narrower case where the relay will
/// not serve the pairing at all — an ordinary decline reaches us as `expired`,
/// because a person who says no on the other device sends nothing.
enum PairingState {
    case idle
    case waiting
    case received
    case expired
    case refused
}

/// What the scanner is doing on an already-unlocked device.
enum ScanPhase {
    case closed
    /// The camera is live, waiting for a code.
    case scanning
    /// A code was read and parsed; the sheet names the device it came from.
    case confirming
    /// Send was pressed: the vault key is being sealed and posted.
    case sending
    /// The key is on the relay. The other device collects it.
    case sent
}

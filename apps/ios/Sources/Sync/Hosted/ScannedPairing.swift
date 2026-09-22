import Foundation

/// A pairing code the engine has already parsed, and the one way to answer it.
///
/// Rust's `PairingRequest` is an opaque handle Swift cannot build, and
/// `confirm_pairing` is the only call that takes one — that is what makes the
/// confirmation sheet a real gate rather than a convention, because a wrong
/// scan has nothing to send (ADR 0003, decision 5). This protocol keeps that
/// shape while giving the wizard something a test can hand it, since a camera
/// is the one thing a simulator does not have (ADR 0003, decision 12).
///
/// Nothing here carries a vault key: `send()` is Rust sealing this device's key
/// to the scanned public key and posting it to the relay.
protocol ScannedPairing {
    /// What the new device calls itself. Self-reported by that device and shown
    /// verbatim on the confirmation sheet.
    var deviceName: String { get }
    /// `ios`, `android`, or `desktop`.
    var platform: String { get }
    /// The confirm step. The only call in the app that sends a vault key.
    func send() async throws
}

/// The live one: Rust's parsed request, plus the state machine that will seal
/// and post to it. The request never leaves this object, so nothing above it
/// ever holds the pairing id or the public key.
struct RustScannedPairing: ScannedPairing {
    let request: PairingRequest
    let setup: HostedSetupClientProtocol

    var deviceName: String { request.deviceName() }
    var platform: String { request.platform() }

    func send() async throws {
        try await setup.confirmPairing(request: request)
    }
}

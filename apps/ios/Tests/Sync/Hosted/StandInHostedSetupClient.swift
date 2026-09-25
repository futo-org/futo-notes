import Foundation

@testable import FutoNotesNative

/// Rust's `HostedSetup`, as far as anything driving `HostedSetupClientProtocol`
/// can tell.
///
/// The iOS wizard's own scenario coverage moved to Kotlin's
/// `HostedSetupModelTest.kt` (test-reduction lever C, 2026-09-24); this fake
/// survives because `SyncManagerRestoreTests.swift` still needs it to drive
/// `SyncManager` — a second copy of it there would be the same stand-in
/// written twice. Not itself a test.
final class StandInHostedSetupClient: HostedSetupClientProtocol {
    var signedIn = false
    var entitled = false
    var vaultHasKeyMaterial = false
    var deviceHoldsKey = false

    var signInOutcome: SignInOutcome = .signedIn(
        session: HostedSession(
            userId: "user-1", email: "person@futo.org", name: "Person", token: "token"))
    var checkout: Checkout = .open(url: "https://pay.example/checkout")
    var entitlementOutcome: EntitlementOutcome?
    var state = "active"
    var graceUntil: String?
    var quotaBytes: UInt64 = 10_000_000_000
    var usedBytes: UInt64 = 4_210_688
    var portalURL = "https://pay.example/portal"
    var recoveryKey = "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345"

    var pairingCode = PairingCode(
        payload: #"{"futo_notes_pairing":1,"id":"pairing-1"}"#,
        expiresAt: "2099-01-01T00:05:00Z")
    var pairingOutcome: PairingOutcome = .paired
    /// What `awaitPairing` throws instead of answering — the expired and
    /// refused screens are both reached this way.
    var pairingFailure: HostedError?
    /// Hold the wait open so a test can cancel a LIVE one.
    var suspendAwaitPairing = false
    /// True once the held wait is actually suspended — the point from which
    /// cancelling it is cancelling something real.
    private(set) var waitingForPairing = false
    private var heldPairingWait: CheckedContinuation<PairingOutcome, Error>?
    private var pairingCancelledEarly = false
    private(set) var pairedDeviceNames: [String] = []

    var nextFailure: HostedError?
    var cancelWaitCount = 0
    private(set) var calls: [String] = []

    func serverUrl() -> String { "https://notes-sync.example" }

    func session() -> HostedSession? {
        guard signedIn, case .signedIn(let session) = signInOutcome else { return nil }
        return session
    }

    func beginSignIn() async throws -> SignInHandoff {
        try record("beginSignIn")
        return SignInHandoff(url: "https://accounts.example/handoff", ticket: "ticket")
    }

    func awaitSignIn(handoff: SignInHandoff) async throws -> SignInOutcome {
        try record("awaitSignIn")
        if case .signedIn = signInOutcome { signedIn = true }
        return signInOutcome
    }

    func cancelWait() {
        cancelWaitCount += 1
        guard let held = heldPairingWait else {
            // Cancelled before the wait suspended; the next one ends at once.
            pairingCancelledEarly = true
            return
        }
        heldPairingWait = nil
        waitingForPairing = false
        held.resume(returning: .cancelled)
    }

    func beginPairing(deviceName: String) async throws -> PairingCode {
        try record("beginPairing")
        pairedDeviceNames.append(deviceName)
        return pairingCode
    }

    func awaitPairing() async throws -> PairingOutcome {
        try record("awaitPairing")
        if let pairingFailure { throw pairingFailure }
        var outcome = pairingOutcome
        if suspendAwaitPairing {
            if pairingCancelledEarly {
                pairingCancelledEarly = false
                outcome = .cancelled
            } else {
                outcome = try await withCheckedThrowingContinuation { held in
                    heldPairingWait = held
                    waitingForPairing = true
                }
            }
        }
        if case .paired = outcome { deviceHoldsKey = true }
        return outcome
    }

    /// Rust's `PairingRequest` is an opaque handle Swift cannot build —
    /// that is the point of it, and it is why the wizard reaches parsing
    /// through an injected `parseScanned` rather than through this. Nothing
    /// in these tests calls it.
    func completePairing(scanned: String) throws -> PairingRequest {
        try record("completePairing")
        throw HostedError.PairingCodeInvalid
    }

    func confirmPairing(request: PairingRequest) async throws {
        try record("confirmPairing")
    }

    func currentStep() async throws -> SetupStep {
        try record("currentStep")
        if !signedIn { return .signIn }
        if vaultHasKeyMaterial { return deviceHoldsKey ? .ready : .unlock }
        return entitled ? .createVault : .subscribe
    }

    func billingStatus() async throws -> BillingStatus {
        try record("billingStatus")
        return BillingStatus(
            entitled: entitled,
            state: state,
            graceUntil: graceUntil,
            storageQuotaBytes: quotaBytes,
            blobMaxBytes: 104_857_600,
            bytesUsed: usedBytes
        )
    }

    func billingPortal() async throws -> String {
        try record("billingPortal")
        return portalURL
    }

    func beginCheckout() async throws -> Checkout {
        try record("beginCheckout")
        return checkout
    }

    func awaitEntitled() async throws -> EntitlementOutcome {
        try record("awaitEntitled")
        if let entitlementOutcome { return entitlementOutcome }
        entitled = true
        return .entitled(status: try await billingStatus())
    }

    func createVault(vaultPassword: String) async throws -> String {
        try record("createVault")
        if vaultHasKeyMaterial { throw HostedError.VaultAlreadyExists }
        vaultHasKeyMaterial = true
        deviceHoldsKey = true
        return recoveryKey
    }

    func unlockWithVaultPassword(vaultPassword: String) async throws {
        try record("unlockWithVaultPassword")
        deviceHoldsKey = true
    }

    func unlockWithRecoveryKey(typed: String) async throws {
        try record("unlockWithRecoveryKey")
        deviceHoldsKey = true
    }

    func signOut(sync: SyncClient) async throws {
        try record("signOut")
        signedIn = false
        deviceHoldsKey = false
    }

    func connectSync(sync: SyncClient) async throws {
        try record("connectSync")
    }

    func hasSavedVault() async throws -> Bool {
        try record("hasSavedVault")
        return signedIn && deviceHoldsKey
    }

    /// The two account-card re-wraps. Both hold the rule the engine holds:
    /// a device that does not have the vault key has nothing to re-wrap,
    /// and neither asks for a current secret.
    var vaultPassword = "a long enough vault password"
    var replacementRecoveryKey = "ZYXW-VTSR-QPNM-KJHG-FEDC-BA98-7654"

    func changeVaultPassword(newPassword: String) async throws {
        try record("changeVaultPassword")
        guard deviceHoldsKey else { throw HostedError.VaultLocked }
        vaultPassword = newPassword
    }

    func newRecoveryKey() async throws -> String {
        try record("newRecoveryKey")
        guard deviceHoldsKey else { throw HostedError.VaultLocked }
        return replacementRecoveryKey
    }

    private func record(_ call: String) throws {
        calls.append(call)
        if let failure = nextFailure {
            nextFailure = nil
            throw failure
        }
    }
}

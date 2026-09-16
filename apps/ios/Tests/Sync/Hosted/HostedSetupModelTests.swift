import Foundation
import Testing

@testable import FutoNotesNative

/// The iOS wizard, driven against a stand-in for Rust's state machine.
///
/// The stand-in derives its step from the same four facts Rust does — is there
/// a session, does the vault have key material, does this device hold the key,
/// may the account write — so a test that walks a wizard shape is testing that
/// the shell *follows* those facts rather than counting screens of its own.
@Suite("Hosted setup wizard")
@MainActor
struct HostedSetupModelTests {

    // MARK: - Stand-ins

    /// Rust's `HostedSetup`, as far as the wizard can tell.
    final class StandInSetup: HostedSetupClientProtocol {
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

    /// The shell, with the auth sheet and pasteboard replaced by a log.
    final class StandInShell: HostedSetupShell {
        private(set) var openedURLs: [URL] = []
        private(set) var closes = 0
        private(set) var pasteboard: String?
        private(set) var announcements: [String] = []
        /// Set to have the person "close the sheet" the moment it opens.
        var dismissImmediately = false
        private var onDismiss: (() -> Void)?

        func openAuthSheet(_ url: URL, onDismiss: @escaping () -> Void) {
            openedURLs.append(url)
            self.onDismiss = onDismiss
            if dismissImmediately { onDismiss() }
        }

        var deviceName = "A stand-in iPhone"

        func closeAuthSheet() { closes += 1 }
        func copyToPasteboard(_ text: String) { pasteboard = text }
        func announce(_ message: LocalizedMessage) { announcements.append(message.path) }

        /// The person swiping the sheet away mid-wait.
        func dismissSheet() { onDismiss?() }
    }

    /// A scanned code, standing in for the one Rust parses. A simulator has no
    /// camera, so the string that reaches the wizard is injected — everything
    /// downstream of it is the same code a real camera would drive (ADR 0003,
    /// decision 12).
    final class StandInScan: ScannedPairing {
        let deviceName: String
        let platform: String
        /// What the relay refuses the confirm with, if anything.
        var failure: HostedError?
        private(set) var sends = 0

        init(deviceName: String = "New iPad", platform: String = "ios") {
            self.deviceName = deviceName
            self.platform = platform
        }

        func send() async throws {
            sends += 1
            if let failure { throw failure }
        }
    }

    private func makeModel(
        _ setup: StandInSetup,
        _ shell: StandInShell,
        flow: SignInFlow = .hosted(sellsSubscriptions: true),
        scan: StandInScan? = nil,
        scanFailure: HostedError? = nil
    ) -> HostedSetupModel {
        HostedSetupModel(
            makeSetup: { setup },
            shell: shell,
            makeSignOutTarget: {
                SyncClient(
                    notesRoot: NSTemporaryDirectory() + "hosted-tests",
                    serverUrl: "http://127.0.0.1:1")
            },
            probe: { _ in flow },
            parseScanned: { _, _ in
                if let scanFailure { throw scanFailure }
                return scan ?? StandInScan()
            }
        )
    }

    /// Lets a task started by a test reach a state, without a sleep. Everything
    /// here runs on the main actor, so yielding is what hands it the turn.
    private func settle(until reached: () -> Bool) async {
        for _ in 0..<1000 {
            if reached() { return }
            await Task.yield()
        }
    }

    // MARK: - The two wizard shapes

    @Test("a fresh account walks sign in, subscribe, vault password, recovery key, account")
    func theNoVaultShape() async {
        let setup = StandInSetup()
        let shell = StandInShell()
        let model = makeModel(setup, shell)

        await model.load()
        #expect(model.screen == .signIn)

        await model.signIn()
        #expect(model.screen == .subscribe)
        #expect(shell.openedURLs.map(\.absoluteString) == ["https://accounts.example/handoff"])

        await model.subscribe()
        #expect(model.screen == .createVault)
        #expect(shell.openedURLs.count == 2)

        await model.createVault(vaultPassword: "a long enough one")
        #expect(model.screen == .recoveryKey)
        #expect(model.recoveryKey == setup.recoveryKey)

        model.recoveryKeySaved = true
        await model.continueAfterRecoveryKey()
        #expect(model.screen == .account)
        #expect(model.email == "person@futo.org")
        #expect(model.errorMessage == nil)
    }

    @Test("an account that already has a vault walks sign in, unlock, account")
    func theVaultExistsShape() async {
        let setup = StandInSetup()
        setup.vaultHasKeyMaterial = true
        setup.entitled = true
        let shell = StandInShell()
        let model = makeModel(setup, shell)

        await model.load()
        await model.signIn()
        #expect(model.screen == .unlock)

        await model.unlockWithPassword("a long enough one")
        #expect(model.screen == .account)
        #expect(setup.calls.contains("unlockWithVaultPassword"))
        // No subscribe step in this shape: reads are never entitlement-gated.
        #expect(!setup.calls.contains("beginCheckout"))
    }

    @Test("the recovery-key door reaches the same account screen")
    func unlockByRecoveryKey() async {
        let setup = StandInSetup()
        setup.vaultHasKeyMaterial = true
        setup.entitled = true
        let model = makeModel(setup, StandInShell())

        await model.load()
        await model.signIn()
        model.chooseDoor(.recoveryKey)
        await model.unlockWithRecoveryKey("abcd efgh jkmn pqrs tvwx yz01 2345")

        #expect(model.screen == .account)
        #expect(setup.calls.contains("unlockWithRecoveryKey"))
    }

    // MARK: - Where the wizard's position comes from

    @Test("the step is read from the state machine, never remembered here")
    func theStepIsRusts() async {
        let setup = StandInSetup()
        setup.signedIn = true
        setup.entitled = true
        setup.vaultHasKeyMaterial = true
        setup.deviceHoldsKey = true

        let model = makeModel(setup, StandInShell())
        await model.load()
        #expect(model.screen == .account)

        // The same facts a cold start would read, changed behind the shell's
        // back: a device that lost its key is on the unlock screen next time,
        // with nothing in Swift having been told.
        setup.deviceHoldsKey = false
        await model.load()
        #expect(model.screen == .unlock)

        // And a brand-new model over the same facts lands in the same place —
        // there is no position to carry over.
        let coldStart = makeModel(setup, StandInShell())
        await coldStart.load()
        #expect(coldStart.screen == .unlock)
    }

    @Test("a server without FUTO accounts says so instead of opening a sheet")
    func unavailableServer() async {
        let shell = StandInShell()
        let model = makeModel(StandInSetup(), shell, flow: .password)

        await model.load()

        #expect(model.screen == .unavailable)
        #expect(shell.openedURLs.isEmpty)
    }

    // MARK: - The auth sheet

    @Test("dismissing the sign-in sheet leaves the screen where it was, with no error")
    func cancellingSignIn() async {
        let setup = StandInSetup()
        setup.signInOutcome = .cancelled
        let shell = StandInShell()
        shell.dismissImmediately = true
        let model = makeModel(setup, shell)

        await model.load()
        await model.signIn()

        #expect(model.screen == .signIn)
        #expect(model.errorMessage == nil)
        #expect(model.waiting == nil)
        #expect(setup.cancelWaitCount == 1)
    }

    @Test("closing the sheet stops the wait rather than leaving it running")
    func dismissCancelsTheWait() async {
        let setup = StandInSetup()
        setup.signInOutcome = .cancelled
        let shell = StandInShell()
        let model = makeModel(setup, shell)

        await model.load()
        await model.signIn()
        #expect(setup.cancelWaitCount == 0)

        shell.dismissSheet()
        #expect(setup.cancelWaitCount == 1)
    }

    @Test("a sign-in that took too long says to try again")
    func expiredSignIn() async {
        let setup = StandInSetup()
        setup.signInOutcome = .expired
        let model = makeModel(setup, StandInShell())

        await model.load()
        await model.signIn()

        #expect(model.screen == .signIn)
        #expect(model.errorMessage?.path == "sync.hosted.errors.signInExpired")
    }

    @Test("pressing Cancel on the screen takes the sheet down too")
    func cancelWaitingClosesTheSheet() async {
        let setup = StandInSetup()
        let shell = StandInShell()
        let model = makeModel(setup, shell)

        await model.load()
        model.cancelWaiting()

        #expect(setup.cancelWaitCount == 1)
        #expect(shell.closes >= 1)
        #expect(model.waiting == nil)
    }

    @Test("an account that is already entitled skips checkout entirely")
    func alreadyEntitled() async {
        let setup = StandInSetup()
        setup.checkout = .alreadyEntitled(
            status: BillingStatus(
                entitled: true, state: "active", graceUntil: nil,
                storageQuotaBytes: 1, blobMaxBytes: 1, bytesUsed: 0))
        let shell = StandInShell()
        let model = makeModel(setup, shell)

        await model.load()
        await model.signIn()
        setup.entitled = true
        await model.subscribe()

        #expect(model.screen == .createVault)
        #expect(shell.openedURLs.count == 1)  // sign-in only
    }

    @Test("Manage subscription opens a portal URL minted for that press")
    func managingTheSubscription() async {
        let setup = StandInSetup()
        setup.signedIn = true
        setup.entitled = true
        setup.vaultHasKeyMaterial = true
        setup.deviceHoldsKey = true
        let shell = StandInShell()
        let model = makeModel(setup, shell)

        await model.load()
        await model.manageSubscription()

        #expect(shell.openedURLs.map(\.absoluteString) == [setup.portalURL])
    }

    // MARK: - The recovery key

    @Test("the recovery key is shown once and there is no way back to it")
    func theRecoveryKeyIsShownOnce() async {
        let setup = StandInSetup()
        setup.entitled = true
        let shell = StandInShell()
        let model = makeModel(setup, shell)

        await model.load()
        await model.signIn()
        await model.createVault(vaultPassword: "a long enough one")
        #expect(model.recoveryKey != nil)

        model.copyRecoveryKey()
        #expect(shell.pasteboard == setup.recoveryKey)
        #expect(shell.announcements == ["sync.hosted.recoveryKey.copied"])

        model.recoveryKeySaved = true
        await model.continueAfterRecoveryKey()
        #expect(model.recoveryKey == nil)
        #expect(model.recoveryKeySaved == false)

        // Asking the engine again is refused, so there is no second showing
        // even if a shell tried.
        await model.createVault(vaultPassword: "a long enough one")
        #expect(model.recoveryKey == nil)
        #expect(model.errorMessage?.path == "sync.hosted.errors.vaultAlreadyExists")
    }

    // MARK: - Banners

    @Test("a lapsed subscription raises Sync paused, and only on the account screen")
    func syncPausedBanner() async {
        let setup = StandInSetup()
        setup.signedIn = true
        setup.vaultHasKeyMaterial = true
        setup.deviceHoldsKey = true
        setup.entitled = false
        setup.state = "canceled"
        let model = makeModel(setup, StandInShell())

        await model.load()
        #expect(model.screen == .account)
        #expect(model.banner == .syncPaused)
    }

    @Test("a full vault raises Vault is full")
    func vaultFullBanner() async {
        let setup = StandInSetup()
        setup.signedIn = true
        setup.vaultHasKeyMaterial = true
        setup.deviceHoldsKey = true
        setup.entitled = true
        setup.usedBytes = setup.quotaBytes
        let model = makeModel(setup, StandInShell())

        await model.load()
        #expect(model.banner == .vaultFull)
    }

    @Test("Sync paused wins over a full vault: the subscription refuses first")
    func pausedWinsOverFull() async {
        let setup = StandInSetup()
        setup.signedIn = true
        setup.vaultHasKeyMaterial = true
        setup.deviceHoldsKey = true
        setup.entitled = false
        setup.usedBytes = setup.quotaBytes
        let model = makeModel(setup, StandInShell())

        await model.load()
        #expect(model.banner == .syncPaused)
    }

    @Test("no banner while the wizard is still running")
    func noBannerMidWizard() async {
        let setup = StandInSetup()
        setup.signedIn = true
        setup.entitled = false
        let model = makeModel(setup, StandInShell())

        await model.load()
        #expect(model.screen == .subscribe)
        #expect(model.banner == .none)
    }

    // MARK: - Sign out and failures

    @Test("signing out returns the wizard to sign in")
    func signingOut() async {
        let setup = StandInSetup()
        setup.signedIn = true
        setup.entitled = true
        setup.vaultHasKeyMaterial = true
        setup.deviceHoldsKey = true
        let model = makeModel(setup, StandInShell())

        await model.load()
        #expect(model.screen == .account)

        await model.signOut()

        #expect(setup.calls.contains("signOut"))
        #expect(model.screen == .signIn)
        #expect(model.email.isEmpty)
        #expect(model.billing == nil)
    }

    @Test("a failure is reported as a sentence and does not leave the screen busy")
    func failuresAreReported() async {
        let setup = StandInSetup()
        setup.vaultHasKeyMaterial = true
        setup.entitled = true
        let model = makeModel(setup, StandInShell())

        await model.load()
        await model.signIn()
        setup.nextFailure = .RecoveryKeyTypo
        await model.unlockWithRecoveryKey("ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2346")

        #expect(model.errorMessage?.path == "sync.hosted.errors.recoveryKeyTypo")
        #expect(model.busy == false)
        #expect(model.screen == .unlock)
    }

    @Test("an expired session is reported as sign in again, and the vault is not reset")
    func expiredSessionKeepsEverything() async {
        let setup = StandInSetup()
        setup.signedIn = true
        setup.vaultHasKeyMaterial = true
        setup.deviceHoldsKey = true
        setup.entitled = true
        let model = makeModel(setup, StandInShell())

        await model.load()
        setup.nextFailure = .SignInAgain
        await model.manageSubscription()

        #expect(model.errorMessage?.path == "sync.hosted.errors.signInAgain")
        // Still the account screen — nothing about this looks like a reset.
        #expect(model.screen == .account)
    }

    @Test("a failure clears when the next step succeeds")
    func errorsDoNotStick() async {
        let setup = StandInSetup()
        setup.vaultHasKeyMaterial = true
        setup.entitled = true
        let model = makeModel(setup, StandInShell())

        await model.load()
        await model.signIn()
        setup.nextFailure = .WrongVaultPassword
        await model.unlockWithPassword("wrong")
        #expect(model.errorMessage?.path == "sync.hosted.errors.wrongVaultPassword")

        await model.unlockWithPassword("a long enough one")
        #expect(model.errorMessage == nil)
        #expect(model.screen == .account)
    }

    // MARK: - Pairing, the show side (this device is the new one)

    /// Walks the unlock screen's scan door to a vault that is open. `.received`
    /// is the moment the key lands; the account card is what the step read
    /// answers afterwards.
    @Test("showing a code and being answered unlocks this device")
    func showingACodeUnlocksThisDevice() async {
        let setup = StandInSetup()
        setup.vaultHasKeyMaterial = true
        setup.entitled = true
        let shell = StandInShell()
        let model = makeModel(setup, shell)

        await model.load()
        await model.signIn()
        model.chooseDoor(.scan)
        await model.showPairingCode()

        #expect(model.pairing == .received)
        #expect(model.screen == .account)
        // The code carried this device's name, which is the name the other
        // device's confirmation sheet shows.
        #expect(setup.pairedDeviceNames == [shell.deviceName])
        // The payload is gone the moment the wait ends: a spent code is never
        // left on screen.
        #expect(model.pairingPayload == nil)
    }

    @Test("a live code is on screen with the relay's own deadline beside it")
    func aLiveCodeIsDrawnWithItsDeadline() async {
        let setup = StandInSetup()
        setup.vaultHasKeyMaterial = true
        setup.entitled = true
        setup.suspendAwaitPairing = true
        let model = makeModel(setup, StandInShell())

        await model.load()
        await model.signIn()
        model.chooseDoor(.scan)
        let showing = Task { await model.showPairingCode() }
        await settle { setup.waitingForPairing }

        #expect(model.pairingPayload == setup.pairingCode.payload)
        #expect(model.pairingExpiresAt == setup.pairingCode.expiresAt)

        model.cancelPairing()
        await showing.value
    }

    /// The relay carries no declined signal: saying no on the other device
    /// sends nothing, so it reaches a waiting device as the window running out.
    @Test("a code that runs out says expired, which is also what declining looks like")
    func anExpiredCodeIsItsOwnState() async {
        let setup = StandInSetup()
        setup.vaultHasKeyMaterial = true
        setup.entitled = true
        setup.pairingFailure = .PairingExpired
        let model = makeModel(setup, StandInShell())

        await model.load()
        await model.signIn()
        await model.showPairingCode()

        #expect(model.pairing == .expired)
        #expect(model.pairingPayload == nil)
        #expect(model.screen == .unlock)
        // Not an error line: the screen itself says what happened.
        #expect(model.errorMessage == nil)
    }

    @Test("a relay that will not serve the pairing says refused, not expired")
    func aRefusedPairingIsItsOwnState() async {
        for failure in [HostedError.PairingRefused, HostedError.PairingAlreadyKeyed] {
            let setup = StandInSetup()
            setup.vaultHasKeyMaterial = true
            setup.entitled = true
            setup.pairingFailure = failure
            let model = makeModel(setup, StandInShell())

            await model.load()
            await model.signIn()
            await model.showPairingCode()

            #expect(model.pairing == .refused)
            #expect(model.pairingPayload == nil)
        }
    }

    @Test("cancelling a live wait stops it and puts the three doors back")
    func cancellingAWaitPutsTheDoorsBack() async {
        let setup = StandInSetup()
        setup.vaultHasKeyMaterial = true
        setup.entitled = true
        setup.suspendAwaitPairing = true
        let model = makeModel(setup, StandInShell())

        await model.load()
        await model.signIn()
        model.chooseDoor(.scan)
        let showing = Task { await model.showPairingCode() }
        await settle { setup.waitingForPairing }

        model.cancelPairing()
        await showing.value

        #expect(setup.cancelWaitCount == 1)
        #expect(model.pairing == .idle)
        #expect(model.pairingPayload == nil)
        #expect(model.pairingExpiresAt == nil)
        #expect(model.screen == .unlock)
    }

    @Test("choosing another door stops a live wait too")
    func leavingTheScanDoorStopsTheWait() async {
        let setup = StandInSetup()
        setup.vaultHasKeyMaterial = true
        setup.entitled = true
        setup.suspendAwaitPairing = true
        let model = makeModel(setup, StandInShell())

        await model.load()
        await model.signIn()
        model.chooseDoor(.scan)
        let showing = Task { await model.showPairingCode() }
        await settle { setup.waitingForPairing }

        model.chooseDoor(.vaultPassword)
        await showing.value

        #expect(setup.cancelWaitCount == 1)
        #expect(model.pairing == .idle)
        #expect(model.unlockDoor == .vaultPassword)
    }

    // MARK: - Pairing, the scan side (this device already holds the key)

    @Test("a scanned code is named before anything is sent")
    func aScannedCodeIsOnlyParsed() async {
        let setup = StandInSetup()
        setup.signedIn = true
        setup.entitled = true
        setup.vaultHasKeyMaterial = true
        setup.deviceHoldsKey = true
        let scan = StandInScan(deviceName: "Kitchen laptop", platform: "desktop")
        let model = makeModel(setup, StandInShell(), scan: scan)

        await model.load()
        #expect(model.screen == .account)

        model.openScanner()
        #expect(model.scanPhase == .scanning)

        await model.readScannedCode(#"{"futo_notes_pairing":1}"#)

        #expect(model.scanPhase == .confirming)
        #expect(model.scannedPairing?.deviceName == "Kitchen laptop")
        #expect(model.scannedPairing?.platform == "desktop")
        // The confirmation has not happened, so nothing has left this device.
        #expect(scan.sends == 0)
    }

    @Test("Send is the only thing that hands over the vault key")
    func confirmingSendsTheKey() async {
        let setup = StandInSetup()
        setup.signedIn = true
        setup.entitled = true
        setup.vaultHasKeyMaterial = true
        setup.deviceHoldsKey = true
        let scan = StandInScan()
        let model = makeModel(setup, StandInShell(), scan: scan)

        await model.load()
        model.openScanner()
        await model.readScannedCode("code")
        await model.sendVaultKey()

        #expect(scan.sends == 1)
        #expect(model.scanPhase == .sent)
        #expect(model.errorMessage == nil)
    }

    @Test("cancelling the confirmation sends nothing and keeps the camera up")
    func decliningSendsNothing() async {
        let setup = StandInSetup()
        setup.signedIn = true
        setup.entitled = true
        setup.vaultHasKeyMaterial = true
        setup.deviceHoldsKey = true
        let scan = StandInScan()
        let model = makeModel(setup, StandInShell(), scan: scan)

        await model.load()
        model.openScanner()
        await model.readScannedCode("code")
        model.cancelConfirmation()

        #expect(scan.sends == 0)
        #expect(model.scanPhase == .scanning)
        #expect(model.scannedPairing == nil)
    }

    @Test("something that is not a pairing code is named, and nothing is sent")
    func aWrongScanIsNamed() async {
        let setup = StandInSetup()
        setup.signedIn = true
        setup.entitled = true
        setup.vaultHasKeyMaterial = true
        setup.deviceHoldsKey = true
        let model = makeModel(
            setup, StandInShell(), scanFailure: .PairingCodeInvalid)

        await model.load()
        model.openScanner()
        await model.readScannedCode("a wifi QR code")

        #expect(model.errorMessage?.path == "sync.hosted.errors.pairingCodeInvalid")
        #expect(model.scanPhase == .scanning)
        #expect(model.scannedPairing == nil)
    }

    @Test("a refused confirmation says why and puts the camera back")
    func aRefusedConfirmationRecovers() async {
        let setup = StandInSetup()
        setup.signedIn = true
        setup.entitled = true
        setup.vaultHasKeyMaterial = true
        setup.deviceHoldsKey = true
        let scan = StandInScan()
        scan.failure = .PairingAlreadyKeyed
        let model = makeModel(setup, StandInShell(), scan: scan)

        await model.load()
        model.openScanner()
        await model.readScannedCode("code")
        await model.sendVaultKey()

        #expect(model.errorMessage?.path == "sync.hosted.errors.pairingAlreadyKeyed")
        #expect(model.scanPhase == .scanning)
        #expect(model.scannedPairing == nil)
    }

    @Test("a device that no longer holds the key cannot give it away")
    func aLockedDeviceCannotShare() async {
        let setup = StandInSetup()
        setup.signedIn = true
        setup.entitled = true
        setup.vaultHasKeyMaterial = true
        setup.deviceHoldsKey = true
        let scan = StandInScan()
        scan.failure = .VaultLocked
        let model = makeModel(setup, StandInShell(), scan: scan)

        await model.load()
        model.openScanner()
        await model.readScannedCode("code")
        await model.sendVaultKey()

        #expect(model.errorMessage?.path == "sync.hosted.errors.vaultLocked")
    }

    @Test("signing out closes the scanner and abandons any code on screen")
    func signOutClearsPairing() async {
        let setup = StandInSetup()
        setup.signedIn = true
        setup.entitled = true
        setup.vaultHasKeyMaterial = true
        setup.deviceHoldsKey = true
        let model = makeModel(setup, StandInShell())

        await model.load()
        model.openScanner()
        await model.readScannedCode("code")
        await model.signOut()

        #expect(model.scanPhase == .closed)
        #expect(model.scannedPairing == nil)
        #expect(model.pairing == .idle)
        #expect(model.screen == .signIn)
    }

    // MARK: - Changing the vault password, and a new recovery key

    /// A device that finished setup: Rust says ready, so the card is up.
    private func onTheAccountCard() async -> (StandInSetup, StandInShell, HostedSetupModel) {
        let setup = StandInSetup()
        setup.signedIn = true
        setup.entitled = true
        setup.vaultHasKeyMaterial = true
        setup.deviceHoldsKey = true
        let shell = StandInShell()
        let model = makeModel(setup, shell)
        await model.load()
        #expect(model.screen == .account)
        return (setup, shell, model)
    }

    @Test("the new-password screen opens without asking Rust anything")
    func changeVaultPasswordOpensLocally() async {
        let (setup, _, model) = await onTheAccountCard()
        let before = setup.calls.count

        model.beginChangeVaultPassword()

        #expect(model.screen == .changeVaultPassword)
        #expect(setup.calls.count == before)
    }

    @Test("only the new password is sent, and the card comes back")
    func changeVaultPasswordSendsOnlyTheNewOne() async {
        let (setup, shell, model) = await onTheAccountCard()
        model.beginChangeVaultPassword()

        await model.changeVaultPassword("Tr0ubadour&Horse!")

        #expect(setup.vaultPassword == "Tr0ubadour&Horse!")
        #expect(setup.calls.filter { $0 == "changeVaultPassword" }.count == 1)
        #expect(model.screen == .account)
        #expect(model.errorMessage == nil)
        #expect(shell.announcements.contains("sync.hosted.vaultPassword.change.changed"))
    }

    @Test("a stale-key conflict keeps the screen up, and the retry lands")
    func aStaleKeyConflictIsRetryable() async {
        let (setup, _, model) = await onTheAccountCard()
        model.beginChangeVaultPassword()
        setup.nextFailure = .VaultKeyChangedElsewhere

        await model.changeVaultPassword("Tr0ubadour&Horse!")

        #expect(model.screen == .changeVaultPassword)
        #expect(model.errorMessage?.path == "sync.hosted.errors.vaultKeyChangedElsewhere")

        await model.changeVaultPassword("Tr0ubadour&Horse!")
        #expect(model.screen == .account)
        #expect(model.errorMessage == nil)
        #expect(setup.vaultPassword == "Tr0ubadour&Horse!")
    }

    @Test("backing out changes nothing")
    func backingOutOfChangeVaultPassword() async {
        let (setup, _, model) = await onTheAccountCard()
        let password = setup.vaultPassword
        model.beginChangeVaultPassword()

        await model.backToAccount()

        #expect(model.screen == .account)
        #expect(setup.vaultPassword == password)
        #expect(!setup.calls.contains("changeVaultPassword"))
    }

    @Test("a new recovery key lands on the wizard's own save screen, marked a replacement")
    func newRecoveryKeyReusesTheSaveScreen() async {
        let (_, _, model) = await onTheAccountCard()

        await model.newRecoveryKey()

        #expect(model.screen == .recoveryKey)
        #expect(model.recoveryKey == "ZYXW-VTSR-QPNM-KJHG-FEDC-BA98-7654")
        #expect(model.recoveryKeyReplaced)
        #expect(!model.recoveryKeySaved)
    }

    @Test("Continue ends the replacement key, and there is no second copy to ask for")
    func continuingForgetsTheReplacementKey() async {
        let (setup, _, model) = await onTheAccountCard()
        await model.newRecoveryKey()

        await model.continueAfterRecoveryKey()

        #expect(model.recoveryKey == nil)
        #expect(!model.recoveryKeyReplaced)
        #expect(model.screen == .account)
        #expect(setup.calls.filter { $0 == "newRecoveryKey" }.count == 1)
    }

    @Test("a locked device is told why, not left on a half screen")
    func aLockedDeviceCannotReWrap() async {
        let setup = StandInSetup()
        setup.signedIn = true
        setup.entitled = true
        setup.vaultHasKeyMaterial = true
        setup.deviceHoldsKey = false
        let model = makeModel(setup, StandInShell())
        await model.load()
        #expect(model.screen == .unlock)

        await model.newRecoveryKey()

        #expect(model.recoveryKey == nil)
        #expect(model.errorMessage?.path == "sync.hosted.errors.vaultLocked")
    }
}

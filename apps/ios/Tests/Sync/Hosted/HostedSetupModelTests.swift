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

        func cancelWait() { cancelWaitCount += 1 }

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

        func closeAuthSheet() { closes += 1 }
        func copyToPasteboard(_ text: String) { pasteboard = text }
        func announce(_ message: LocalizedMessage) { announcements.append(message.path) }

        /// The person swiping the sheet away mid-wait.
        func dismissSheet() { onDismiss?() }
    }

    private func makeModel(
        _ setup: StandInSetup,
        _ shell: StandInShell,
        flow: SignInFlow = .hosted(sellsSubscriptions: true)
    ) -> HostedSetupModel {
        HostedSetupModel(
            makeSetup: { setup },
            shell: shell,
            makeSignOutTarget: {
                SyncClient(
                    notesRoot: NSTemporaryDirectory() + "hosted-tests",
                    serverUrl: "http://127.0.0.1:1")
            },
            probe: { _ in flow }
        )
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
        model.unlockDoor = .recoveryKey
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
}

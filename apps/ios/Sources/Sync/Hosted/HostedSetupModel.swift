import Foundation
import SwiftUI

/// Everything the hosted sync screen renders from, and everything it can do.
///
/// A direct counterpart of the desktop's `createHostedSyncSettings.svelte.ts`,
/// down to the order of the steps, because the two shells render one state
/// machine and should not have two shapes for it.
@MainActor
final class HostedSetupModel: ObservableObject {
    @Published var screen: HostedScreen = .loading
    @Published private(set) var busy = false
    @Published var waiting: HostedWait?
    @Published var errorMessage: LocalizedMessage?
    /// Where sign-in will happen, so a debug override is never invisible.
    @Published private(set) var serverURL = ""
    @Published private(set) var email = ""
    @Published private(set) var billing: BillingStatus?
    /// Non-nil only while the save-it-now screen is up. Nothing persists it,
    /// nothing else reads it, and `continueAfterRecoveryKey` is the only thing
    /// that clears it. Rust hands it over once and keeps no copy, so once this
    /// is nil there is no way to show it again.
    @Published var recoveryKey: String?
    /// True when the key on that screen replaced one a person already had.
    @Published var recoveryKeyReplaced = false
    /// Rust's own minimum, so the Continue button and the engine cannot
    /// disagree about what a long-enough vault password is.
    @Published private(set) var minimumVaultPasswordLength = 12

    /// The show side of pairing: this device is the new one, drawing a code for
    /// an unlocked device to read.
    @Published var pairing: PairingState = .idle
    /// The payload to draw, straight from Rust. Non-nil only while a live code
    /// is on screen.
    @Published var pairingPayload: String?
    /// RFC 3339, the relay's own deadline — what the countdown describes.
    @Published var pairingExpiresAt: String?

    /// The scan side: this device is the unlocked one, reading someone else's
    /// code.
    @Published var scanPhase: ScanPhase = .closed
    /// The parsed code waiting on a confirmation. Holding one is what makes
    /// Send possible at all; nothing else in this shell can produce one.
    @Published var scannedPairing: (any ScannedPairing)?

    /// Whether the LAST completed cycle's writes were refused, and which way.
    ///
    /// Rust decides it (`futo_notes_sync::WriteRefusal`, projected onto
    /// `SyncSummary.writeRefusal`); `SyncManager` holds the newest answer
    /// because it outlives this screen, and `HostedSyncSections` hands it
    /// over. Never a latch: every completed cycle writes its own answer here,
    /// `nil` included.
    @Published var writeRefusal: WriteRefusal?

    @Published var recoveryKeySaved = false
    /// Which door the unlock screen is showing. `private(set)` because leaving
    /// the scan door has to stop a live wait, which a plain binding cannot do.
    @Published var unlockDoor: UnlockDoor = .vaultPassword
    @Published var selfHostedOpen = false

    /// The state machine this wizard renders. Deferred to the first step so a
    /// secret store that refuses becomes an on-screen sentence like any other
    /// failure, rather than a view that cannot be built.
    private let makeSetup: () throws -> HostedSetupClientProtocol
    let shell: HostedSetupShell
    /// Signing out needs a handle on this vault to demote what is on disk,
    /// exactly as disconnect does — and, once a hosted session is running, it
    /// must be *that* handle, or the live loop outlives the session it belongs
    /// to. Building it is shell work: the engine is handed one, it does not
    /// make one.
    private let signOutEffect: (HostedSetupClientProtocol) async throws -> Void
    /// Started the moment this wizard reaches `ready`: the vault is unlocked,
    /// so a sync can run. Every door ends here — a vault password, a recovery
    /// key, or a paired device — because all three end with the same two
    /// secrets in the same place.
    ///
    /// Run un-awaited, because it is a whole sync cycle and the account card
    /// must not wait on one to appear. Fired once per reached session (see
    /// `connectStarted`), and idempotent beyond that anyway: Rust rebuilds the
    /// same session from the same facts.
    private let connectEffect: (HostedSetupClientProtocol) async -> Void
    /// Reads the server's capability document. A parameter only because it is
    /// the one thing `load` does that talks to the network before there is a
    /// state machine to talk through.
    private let probe: (String) async throws -> SignInFlow
    /// Reads what the camera returned. A parameter because a simulator has no
    /// camera, so the string has to be injectable — everything downstream of it
    /// is the same code either way (ADR 0003, decision 12). The live one is
    /// Rust's `complete_pairing`, which parses and nothing else.
    let parseScanned: (HostedSetupClientProtocol, String) throws -> any ScannedPairing
    var setup: HostedSetupClientProtocol?
    /// Whether the connect for the session this wizard is looking at has been
    /// started. Reset when it observes a signed-out device, so signing back in
    /// starts the next session's sync.
    private var connectStarted = false

    init(
        makeSetup: @escaping () throws -> HostedSetupClientProtocol,
        shell: HostedSetupShell,
        signOutEffect: @escaping (HostedSetupClientProtocol) async throws -> Void,
        connectEffect: @escaping (HostedSetupClientProtocol) async -> Void,
        probe: @escaping (String) async throws -> SignInFlow = { serverUrl in
            try await probeSignInFlow(serverUrl: serverUrl)
        },
        parseScanned: @escaping (HostedSetupClientProtocol, String) throws -> any ScannedPairing = {
            setup, code in
            RustScannedPairing(request: try setup.completePairing(scanned: code), setup: setup)
        }
    ) {
        self.makeSetup = makeSetup
        self.shell = shell
        self.signOutEffect = signOutEffect
        self.connectEffect = connectEffect
        self.probe = probe
        self.parseScanned = parseScanned
    }

    /// Two ways to learn the same thing, and a banner either of them earns.
    ///
    /// `billing` is a reading of the account, taken when this screen opened.
    /// `writeRefusal` is the last cycle's own answer — the 402 or 507 the
    /// server actually returned — which arrives the moment the refused cycle
    /// ends and needs no billing call at all. Neither is a latch.
    ///
    /// Sync paused wins over a full vault, whichever input says so: a lapsed
    /// subscription refuses the write whatever the quota says, so telling
    /// someone to buy more storage would be the wrong instruction.
    ///
    /// Nothing shows before the wizard has finished — which is also what keeps
    /// one account's refusal off the sign-in screen of the next.
    ///
    /// The twin of `hostedBanner.ts` and Android's `HostedSetupModel.banner`
    /// (`hosted-sync-banner-rule` in scripts/drift-registry.json).
    var banner: HostedBanner {
        guard screen == .account else { return .none }
        if writeRefusal == .subscriptionRequired || billing?.entitled == false {
            return .syncPaused
        }
        if writeRefusal == .quotaExceeded { return .vaultFull }
        if let billing, billing.storageQuotaBytes > 0,
            billing.bytesUsed >= billing.storageQuotaBytes
        {
            return .vaultFull
        }
        return .none
    }

    func load() async {
        await step { setup in
            self.serverURL = setup.serverUrl()
            guard case .hosted = try await self.probe(self.serverURL) else {
                // An old deployment, or the hosted name not pointed at one yet.
                // Saying so beats opening a sheet onto a route that is not there.
                self.screen = .unavailable
                return
            }
            self.minimumVaultPasswordLength = Int(minVaultPasswordLength())  // the engine's rule
            try await self.readStep(setup)
        }
    }

    func signIn() async {
        await step { setup in
            let handoff = try await setup.beginSignIn()
            guard let url = URL(string: handoff.url) else {
                self.errorMessage = LocalizedMessage("sync.hosted.errors.server")
                return
            }
            self.shell.openAuthSheet(url) { setup.cancelWait() }
            self.waiting = .signIn
            let outcome = try await setup.awaitSignIn(handoff: handoff)
            self.waiting = nil
            self.shell.closeAuthSheet()
            switch outcome {
            case .cancelled:
                return  // No error and no half state.
            case .expired:
                self.errorMessage = LocalizedMessage("sync.hosted.errors.signInExpired")
            case .signedIn:
                try await self.readStep(setup)
            }
        }
    }

    /// The person pressed Cancel on the screen rather than closing the sheet.
    func cancelWaiting() {
        setup?.cancelWait()
        shell.closeAuthSheet()
        waiting = nil
    }

    func subscribe() async {
        await step { setup in
            let checkout = try await setup.beginCheckout()
            guard case .open(let urlString) = checkout else {
                try await self.readStep(setup)
                return
            }
            guard let url = URL(string: urlString) else {
                self.errorMessage = LocalizedMessage("sync.hosted.errors.server")
                return
            }
            self.shell.openAuthSheet(url) { setup.cancelWait() }
            self.waiting = .checkout
            let outcome = try await setup.awaitEntitled()
            self.waiting = nil
            self.shell.closeAuthSheet()
            switch outcome {
            case .cancelled:
                return
            case .gaveUp(let status):
                self.billing = status
                self.errorMessage = LocalizedMessage("sync.hosted.errors.checkoutGaveUp")
            case .entitled:
                try await self.readStep(setup)
            }
        }
    }

    func createVault(vaultPassword: String) async {
        await step { setup in
            self.recoveryKey = try await setup.createVault(vaultPassword: vaultPassword)
            self.recoveryKeyReplaced = false
            self.recoveryKeySaved = false
            self.screen = .recoveryKey
        }
    }

    func manageSubscription() async {
        await step { setup in
            let portal = try await setup.billingPortal()
            guard let url = URL(string: portal) else {
                self.errorMessage = LocalizedMessage("sync.hosted.errors.server")
                return
            }
            self.shell.openAuthSheet(url) {}
        }
    }

    /// Called only after the confirmation dialog: the confirmation is a view
    /// modifier on iOS, so the view owns it and this owns what it does.
    func signOut() async {
        cancelPairing()
        closeScanner()
        recoveryKey = nil
        recoveryKeyReplaced = false
        await step { setup in
            try await self.signOutEffect(setup)
            try await self.readStep(setup)
        }
    }

    /// Asks Rust which screen we are on, and reads what that screen needs.
    ///
    /// This is the ONLY thing that decides the wizard's position. Nothing here
    /// remembers a step, which is what makes quitting halfway and reopening
    /// land on the right screen rather than on a saved cursor that can
    /// disagree with the server (ADR 0003, decision 3).
    func readStep(_ setup: HostedSetupClientProtocol) async throws {
        switch try await setup.currentStep() {
        case .signIn:
            // Nothing below applies before there is a session, and asking for
            // it would be a round trip that answers "not signed in". A signed-
            // out device also has no session to sync: the next one that reaches
            // `ready` is a new one and starts its own.
            connectStarted = false
            email = ""
            billing = nil
            screen = .signIn
            return
        case .subscribe: screen = .subscribe
        case .createVault: screen = .createVault
        case .unlock: screen = .unlock
        case .ready: screen = .account
        }
        email = setup.session()?.email ?? ""
        billing = try await setup.billingStatus()
        if screen == .account { startConnect(setup) }
    }

    /// The end of the wizard is a running sync, not a set-up vault that sits
    /// there. Started once per reached session — the first read that lands on
    /// `ready`, which is also the read every door ends with — and left to run
    /// on its own, because a sync cycle is not something the account card
    /// should wait behind.
    private func startConnect(_ setup: HostedSetupClientProtocol) {
        if connectStarted { return }
        connectStarted = true
        Task { [weak self] in
            await self?.connectEffect(setup)
            await self?.refreshBilling()
        }
    }

    /// Re-reads the account after that first cycle, so the usage on the card is
    /// what this vault now weighs rather than what it weighed before anything
    /// had been uploaded. A read that fails leaves the card as it was: the
    /// figure on it is stale, not wrong, and blanking it would say less.
    private func refreshBilling() async {
        guard let setup, screen == .account else { return }
        if let status = try? await setup.billingStatus() { billing = status }
    }

    /// Runs one step, reporting whatever it fails with as a sentence. Nothing
    /// else here catches, so no failure can leave the screen busy forever.
    func step(_ work: (HostedSetupClientProtocol) async throws -> Void) async {
        if busy { return }
        busy = true
        errorMessage = nil
        do {
            let setup = try self.setup ?? makeSetup()
            self.setup = setup
            try await work(setup)
        } catch {
            NSLog("[hosted] step failed: %@", "\(error)")
            errorMessage = hostedErrorMessage(error)
        }
        busy = false
        waiting = nil
    }
}

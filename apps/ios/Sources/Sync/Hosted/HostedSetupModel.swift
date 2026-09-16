import Foundation
import SwiftUI

/// Which hosted screen to render.
///
/// Five of these are Rust's `SetupStep` verbatim. `recoveryKey` is not a step
/// and deliberately has no Rust variant: it exists only for as long as this
/// object holds the string `createVault` handed back, which happens exactly
/// once per vault because a second create is refused (ADR 0003, decision 3).
/// `loading` and `unavailable` are this shell's own — the moment before Rust
/// has answered, and a server that does not offer hosted sync at all.
enum HostedScreen {
    case loading
    case unavailable
    case signIn
    case subscribe
    case createVault
    case recoveryKey
    case unlock
    case account
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

/// Everything the hosted sync screen renders from, and everything it can do.
///
/// A direct counterpart of the desktop's `createHostedSyncSettings.svelte.ts`,
/// down to the order of the steps, because the two shells render one state
/// machine and should not have two shapes for it.
@MainActor
final class HostedSetupModel: ObservableObject {
    @Published private(set) var screen: HostedScreen = .loading
    @Published private(set) var busy = false
    @Published private(set) var waiting: HostedWait?
    @Published private(set) var errorMessage: LocalizedMessage?
    /// Where sign-in will happen, so a debug override is never invisible.
    @Published private(set) var serverURL = ""
    @Published private(set) var email = ""
    @Published private(set) var billing: BillingStatus?
    /// Non-nil only while the save-it-now screen is up. Nothing persists it,
    /// nothing else reads it, and `continueAfterRecoveryKey` is the only thing
    /// that clears it. Rust hands it over once and keeps no copy, so once this
    /// is nil there is no way to show it again.
    @Published private(set) var recoveryKey: String?
    /// Rust's own minimum, so the Continue button and the engine cannot
    /// disagree about what a long-enough vault password is.
    @Published private(set) var minimumVaultPasswordLength = 12

    @Published var recoveryKeySaved = false
    @Published var unlockDoor: UnlockDoor = .vaultPassword
    @Published var selfHostedOpen = false

    /// The state machine this wizard renders. Deferred to the first step so a
    /// secret store that refuses becomes an on-screen sentence like any other
    /// failure, rather than a view that cannot be built.
    private let makeSetup: () throws -> HostedSetupClientProtocol
    private let shell: HostedSetupShell
    private let makeSignOutTarget: () -> SyncClient
    /// Reads the server's capability document. A parameter only because it is
    /// the one thing `load` does that talks to the network before there is a
    /// state machine to talk through.
    private let probe: (String) async throws -> SignInFlow
    private var setup: HostedSetupClientProtocol?

    init(
        makeSetup: @escaping () throws -> HostedSetupClientProtocol,
        shell: HostedSetupShell,
        makeSignOutTarget: @escaping () -> SyncClient,
        probe: @escaping (String) async throws -> SignInFlow = { serverUrl in
            try await probeSignInFlow(serverUrl: serverUrl)
        }
    ) {
        self.makeSetup = makeSetup
        self.shell = shell
        self.makeSignOutTarget = makeSignOutTarget
        self.probe = probe
    }

    /// A banner is a fact about the account, read the same way the account card
    /// reads everything else. Sync paused wins over a full vault: a lapsed
    /// subscription refuses the write whatever the quota says, so telling
    /// someone to buy more storage would be the wrong instruction.
    var banner: HostedBanner {
        guard screen == .account, let billing else { return .none }
        if !billing.entitled { return .syncPaused }
        if billing.storageQuotaBytes > 0, billing.bytesUsed >= billing.storageQuotaBytes {
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
            self.recoveryKeySaved = false
            self.screen = .recoveryKey
        }
    }

    func copyRecoveryKey() {
        guard let recoveryKey else { return }
        shell.copyToPasteboard(recoveryKey)
        shell.announce(LocalizedMessage("sync.hosted.recoveryKey.copied"))
    }

    func continueAfterRecoveryKey() async {
        recoveryKey = nil
        recoveryKeySaved = false
        await step { setup in try await self.readStep(setup) }
    }

    func unlockWithPassword(_ vaultPassword: String) async {
        await step { setup in
            try await setup.unlockWithVaultPassword(vaultPassword: vaultPassword)
            try await self.readStep(setup)
        }
    }

    func unlockWithRecoveryKey(_ typed: String) async {
        await step { setup in
            try await setup.unlockWithRecoveryKey(typed: typed)
            try await self.readStep(setup)
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
        await step { setup in
            try await setup.signOut(sync: self.makeSignOutTarget())
            try await self.readStep(setup)
        }
    }

    /// Asks Rust which screen we are on, and reads what that screen needs.
    ///
    /// This is the ONLY thing that decides the wizard's position. Nothing here
    /// remembers a step, which is what makes quitting halfway and reopening
    /// land on the right screen rather than on a saved cursor that can
    /// disagree with the server (ADR 0003, decision 3).
    private func readStep(_ setup: HostedSetupClientProtocol) async throws {
        switch try await setup.currentStep() {
        case .signIn:
            // Nothing below applies before there is a session, and asking for
            // it would be a round trip that answers "not signed in".
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
    }

    /// Runs one step, reporting whatever it fails with as a sentence. Nothing
    /// else here catches, so no failure can leave the screen busy forever.
    private func step(_ work: (HostedSetupClientProtocol) async throws -> Void) async {
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

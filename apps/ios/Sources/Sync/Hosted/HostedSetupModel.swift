import Foundation
import SwiftUI

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
    /// True when the key on that screen replaced one a person already had.
    @Published private(set) var recoveryKeyReplaced = false
    /// Rust's own minimum, so the Continue button and the engine cannot
    /// disagree about what a long-enough vault password is.
    @Published private(set) var minimumVaultPasswordLength = 12

    /// The show side of pairing: this device is the new one, drawing a code for
    /// an unlocked device to read.
    @Published private(set) var pairing: PairingState = .idle
    /// The payload to draw, straight from Rust. Non-nil only while a live code
    /// is on screen.
    @Published private(set) var pairingPayload: String?
    /// RFC 3339, the relay's own deadline — what the countdown describes.
    @Published private(set) var pairingExpiresAt: String?

    /// The scan side: this device is the unlocked one, reading someone else's
    /// code.
    @Published private(set) var scanPhase: ScanPhase = .closed
    /// The parsed code waiting on a confirmation. Holding one is what makes
    /// Send possible at all; nothing else in this shell can produce one.
    @Published private(set) var scannedPairing: (any ScannedPairing)?

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
    @Published private(set) var unlockDoor: UnlockDoor = .vaultPassword
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
    /// Reads what the camera returned. A parameter because a simulator has no
    /// camera, so the string has to be injectable — everything downstream of it
    /// is the same code either way (ADR 0003, decision 12). The live one is
    /// Rust's `complete_pairing`, which parses and nothing else.
    private let parseScanned: (HostedSetupClientProtocol, String) throws -> any ScannedPairing
    private var setup: HostedSetupClientProtocol?

    init(
        makeSetup: @escaping () throws -> HostedSetupClientProtocol,
        shell: HostedSetupShell,
        makeSignOutTarget: @escaping () -> SyncClient,
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
        self.makeSignOutTarget = makeSignOutTarget
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

    /// Opens the new-password screen. No round trip and no current secret
    /// asked: this device holds the vault key already, and a device paired by
    /// QR never knew the old password (ADR 0003, decision 10).
    func beginChangeVaultPassword() {
        errorMessage = nil
        screen = .changeVaultPassword
    }

    /// Re-wraps the password envelope and goes back to the account card.
    ///
    /// Rust re-wraps the same vault key, so every other device carries on with
    /// what it already holds and is never told anything happened (parent spec
    /// user story 33). A `VaultKeyChangedElsewhere` rejection leaves this
    /// screen up with that sentence on it, because pressing the button again
    /// is the whole remedy.
    func changeVaultPassword(_ newPassword: String) async {
        await step { setup in
            try await setup.changeVaultPassword(newPassword: newPassword)
            self.shell.announce(LocalizedMessage("sync.hosted.vaultPassword.change.changed"))
            try await self.readStep(setup)
        }
    }

    /// Issues a new recovery key and shows it on the same save screen the
    /// wizard uses — the old one has stopped working by the time it appears.
    func newRecoveryKey() async {
        await step { setup in
            self.recoveryKey = try await setup.newRecoveryKey()
            self.recoveryKeyReplaced = true
            self.recoveryKeySaved = false
            self.screen = .recoveryKey
        }
    }

    /// Leaves an account-card detour without doing anything.
    func backToAccount() async {
        await step { setup in try await self.readStep(setup) }
    }

    func copyRecoveryKey() {
        guard let recoveryKey else { return }
        shell.copyToPasteboard(recoveryKey)
        shell.announce(LocalizedMessage("sync.hosted.recoveryKey.copied"))
    }

    func continueAfterRecoveryKey() async {
        recoveryKey = nil
        recoveryKeyReplaced = false
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

    /// Moves the unlock screen to another door, stopping a live pairing wait on
    /// the way out. A code that is already on the relay cannot be withdrawn, so
    /// leaving abandons it rather than resuming it.
    func chooseDoor(_ door: UnlockDoor) {
        if unlockDoor == .scan, door != .scan { cancelPairing() }
        unlockDoor = door
    }

    /// Opens a pairing and shows its code until the other device answers.
    ///
    /// One call covers the whole wait: Rust mints the one-time keypair,
    /// publishes the public half to the relay, and polls for the sealed vault
    /// key until the relay's own five minutes are up. What comes back decides
    /// the state, which is why nothing here has its own timer — the countdown
    /// on screen only describes that deadline, it does not enforce it.
    func showPairingCode() async {
        await step { setup in
            self.pairing = .idle
            self.pairingPayload = nil
            let code = try await setup.beginPairing(deviceName: self.shell.deviceName)
            self.pairingPayload = code.payload
            self.pairingExpiresAt = code.expiresAt
            self.pairing = .waiting
            do {
                let outcome = try await setup.awaitPairing()
                self.pairingPayload = nil
                if case .cancelled = outcome {
                    self.pairing = .idle
                    return
                }
                // The key arrived and is kept: this device is unlocked. Said
                // here rather than after the step read, so the code's
                // disappearance is explained while that read is in flight.
                self.pairing = .received
                try await self.readStep(setup)
            } catch {
                self.pairingPayload = nil
                switch error as? HostedError {
                // A person who declined on the other device sent nothing, so
                // this is also what declining looks like from here. The copy
                // says so rather than claiming to know which happened.
                case .PairingExpired:
                    self.pairing = .expired
                case .PairingRefused, .PairingAlreadyKeyed:
                    self.pairing = .refused
                default:
                    self.pairing = .idle
                    throw error
                }
            }
        }
    }

    /// Stops waiting and puts the three doors back. Deliberately outside
    /// `step`: the wait it is cancelling is what holds `busy`.
    func cancelPairing() {
        if pairing == .waiting { setup?.cancelWait() }
        pairing = .idle
        pairingPayload = nil
        pairingExpiresAt = nil
    }

    /// Opens the camera on an unlocked device (parent spec user story 15).
    func openScanner() {
        errorMessage = nil
        scannedPairing = nil
        scanPhase = .scanning
    }

    /// One code, from the camera or from a test. Parsing touches no network, no
    /// secret store, and no vault key — all it answers is the name to put on
    /// the confirmation sheet.
    func readScannedCode(_ code: String) async {
        await step { setup in
            self.scannedPairing = try self.parseScanned(setup, code)
            self.scanPhase = .confirming
        }
    }

    /// The confirmation (parent spec user story 16). This is the only thing in
    /// the app that sends a vault key anywhere.
    func sendVaultKey() async {
        guard let scanned = scannedPairing else { return }
        await step { _ in
            self.scanPhase = .sending
            do {
                try await scanned.send()
            } catch {
                // A refused or already-answered pairing cannot be retried, and
                // a locked device has nothing to give: either way the next
                // useful move is a fresh code, so the camera goes back on with
                // the reason on screen.
                self.scannedPairing = nil
                self.scanPhase = .scanning
                throw error
            }
            self.scanPhase = .sent
        }
    }

    /// Said no on the confirmation sheet. Nothing was sent, and nothing is kept.
    func cancelConfirmation() {
        scannedPairing = nil
        errorMessage = nil
        scanPhase = .scanning
    }

    func closeScanner() {
        scannedPairing = nil
        scanPhase = .closed
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

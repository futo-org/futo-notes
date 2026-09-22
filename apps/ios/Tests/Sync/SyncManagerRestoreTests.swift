import Foundation
import Testing

@testable import FutoNotesNative

/// What a cold start does with what this device saved.
///
/// Two kinds of vault reach `restoreSession`: one set up against someone's own
/// server, which has a password to reconnect with, and a hosted one, which has
/// none and is recognised instead by the two secrets Rust saved. Which branch
/// runs is the whole of what these check — the connect itself is Rust's, and
/// the hosted scenarios in `crates/futo-notes-sync` exercise it.
@Suite("Restoring a sync session at launch")
@MainActor
struct SyncManagerRestoreTests {
    /// Rust's hosted state machine, as far as the manager can tell. The wizard
    /// tests already own one; a second copy here would be the same stand-in
    /// written twice.
    private typealias StandInSetup = HostedSetupModelTests.StandInSetup

    private func manager(_ hosted: StandInSetup) -> SyncManager {
        let manager = SyncManager()
        manager.makeHostedSetup = { _ in hosted }
        // Empty rather than the debug default, so the password branch is
        // rejected by its own validation instead of reaching for a network.
        manager.serverURL = ""
        return manager
    }

    /// A hosted device that finished its wizard: signed in, holding the key.
    private func aSetUpHostedDevice() -> StandInSetup {
        let hosted = StandInSetup()
        hosted.signedIn = true
        hosted.vaultHasKeyMaterial = true
        hosted.deviceHoldsKey = true
        return hosted
    }

    private let root = NSTemporaryDirectory() + "sync-manager-restore-tests"

    /// The stored sync password is global to the app rather than scoped per
    /// vault, so a test that writes one puts back whatever the simulator had.
    private func withStoredPassword(_ password: String?, _ body: () async -> Void) async {
        let previous = Keychain.syncPassword
        Keychain.syncPassword = password
        await body()
        Keychain.syncPassword = previous
    }

    /// D9, Justin's call of 2026-09-16. A device holding BOTH is one stranded
    /// by a build from before a hosted connect cleared the password — neither
    /// shell offers the self-hosted fields once hosted sync is set up, so a
    /// person cannot create this state any more. It resumes hosted, and that
    /// connect clears the password, so the ambiguity retires itself.
    @Test("a device stranded with both a password and a hosted vault resumes hosted")
    func aStrandedDeviceResumesHosted() async {
        let hosted = aSetUpHostedDevice()
        let manager = manager(hosted)

        await withStoredPassword("a stored sync password") {
            await manager.restoreSession(notesRoot: root)
        }

        #expect(hosted.calls.contains("hasSavedVault"))
        #expect(
            hosted.calls.contains("connectSync"),
            "a stranded device went back to its old server instead of resuming hosted: \(hosted.calls)")
    }

    /// The other half of the same rule, and the reason this is not simply
    /// "prefer hosted": with no hosted vault the stored password still wins, so
    /// a self-hosted device stays self-hosted.
    @Test("a device with only a password still restores the self-hosted session")
    func onlyAPasswordStaysSelfHosted() async {
        let hosted = StandInSetup()  // never signed in, holds no key
        let manager = manager(hosted)

        await withStoredPassword("a stored sync password") {
            await manager.restoreSession(notesRoot: root)
        }

        #expect(
            !hosted.calls.contains("connectSync"),
            "a self-hosted vault's restore connected the hosted wizard: \(hosted.calls)")
        // Rejected by the empty-server-URL validation, which is the password
        // branch having been taken.
        #expect(manager.statusMessage.path == "sync.status.error")
    }

    @Test("a device with no password restores its hosted session")
    func aHostedDeviceRestoresWithoutAPassword() async {
        let hosted = aSetUpHostedDevice()
        let manager = manager(hosted)

        await withStoredPassword(nil) {
            await manager.restoreSession(notesRoot: root)
        }

        #expect(hosted.calls.contains("hasSavedVault"))
        #expect(
            hosted.calls.contains("connectSync"),
            "a hosted vault did not resume at launch: \(hosted.calls)")
    }

    @Test("a device with nothing saved connects nothing and says nothing broke")
    func nothingSavedConnectsNothing() async {
        let hosted = StandInSetup()  // never signed in, holds no key
        let manager = manager(hosted)

        await withStoredPassword(nil) {
            await manager.restoreSession(notesRoot: root)
        }

        #expect(hosted.calls == ["hasSavedVault"])
        #expect(!manager.connected)
        #expect(manager.statusMessage.path == "sync.status.notConnected")
        #expect(manager.lastErrorMessage == nil)
    }

    @Test("an unfinished wizard is not an error")
    func anUnfinishedWizardIsNotAnError() async {
        for failure in [HostedError.NotSignedIn, HostedError.VaultLocked] {
            let hosted = aSetUpHostedDevice()
            hosted.nextFailure = failure
            let manager = manager(hosted)

            await manager.connectHosted(notesRoot: root, setup: hosted)

            #expect(
                manager.lastErrorMessage == nil,
                "\(failure) surfaced as a sync failure rather than an unfinished setup")
            #expect(manager.statusMessage.path == "sync.status.notConnected")
        }
    }

    /// Offline at boot keeps everything. The secrets are still good, so this is
    /// the muted line the live stream uses and not the red one — and the next
    /// foreground tries again.
    @Test("a hosted connect with no network is muted, not alarming")
    func offlineAtBootIsMuted() async {
        let hosted = aSetUpHostedDevice()
        hosted.nextFailure = .Network(reason: "no route to host")
        let manager = manager(hosted)

        await manager.connectHosted(notesRoot: root, setup: hosted)

        #expect(manager.lastErrorMessage == nil)
        #expect(manager.liveErrorMessage?.path == "sync.errors.hostedOffline")
        #expect(manager.statusMessage.path == "sync.status.notConnected")
    }
}

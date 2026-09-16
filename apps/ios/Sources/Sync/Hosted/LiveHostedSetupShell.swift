import Foundation
import UIKit

/// The live wiring behind the hosted wizard: the iOS auth sheet, the
/// pasteboard, and the app's transient banner. Every one of these is a thing
/// Rust cannot do; nothing here decides anything.
@MainActor
final class LiveHostedSetupShell: HostedSetupShell {
    private let authSheet = AuthSheet()
    private weak var store: NotesStore?

    init(store: NotesStore) {
        self.store = store
    }

    /// What iOS says this device is called. On a physical device since iOS 16
    /// an unentitled app is given the model name ("iPhone") rather than the
    /// name in Settings — a simulator still reports its own. Either is an
    /// honest answer for the other device's confirmation sheet, and asking for
    /// the user-assigned-device-name entitlement to make it prettier is not
    /// worth a review conversation.
    var deviceName: String { UIDevice.current.name }

    func openAuthSheet(_ url: URL, onDismiss: @escaping () -> Void) {
        authSheet.open(url, onDismiss: onDismiss)
    }

    func closeAuthSheet() {
        authSheet.close()
    }

    func copyToPasteboard(_ text: String) {
        UIPasteboard.general.string = text
    }

    func announce(_ message: LocalizedMessage) {
        store?.showTransient(message)
    }
}

extension HostedSetupModel {
    /// The wizard as the app runs it: Rust's state machine over this vault's
    /// Keychain entries, the iOS auth sheet, and a handle on the same vault for
    /// sign out to demote through.
    static func live(notesRoot: String, store: NotesStore) -> HostedSetupModel {
        HostedSetupModel(
            makeSetup: {
                try HostedSetupClient.hosted(
                    secrets: KeychainVaultSecretStore(notesRoot: notesRoot))
            },
            shell: LiveHostedSetupShell(store: store),
            // Hosted sync does not run a session yet (futo-notes#186), so there
            // is no live hosted client to reuse; `signOut` only needs a handle
            // on the vault to demote what is on disk, exactly as disconnect
            // does.
            makeSignOutTarget: {
                SyncClient(notesRoot: notesRoot, serverUrl: hostedServerUrl())
            }
        )
    }
}

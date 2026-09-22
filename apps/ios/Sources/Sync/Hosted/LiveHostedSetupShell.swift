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
    /// Keychain entries, the iOS auth sheet, and the app's one `SyncManager`
    /// for the two things that are sessions rather than screens — starting one
    /// when the wizard finishes, and revoking the live one on sign out.
    static func live(notesRoot: String, store: NotesStore, sync: SyncManager) -> HostedSetupModel {
        HostedSetupModel(
            makeSetup: {
                try HostedSetupClient.hosted(
                    secrets: KeychainVaultSecretStore(notesRoot: notesRoot))
            },
            shell: LiveHostedSetupShell(store: store),
            // Through the manager, so Rust revokes the session that is actually
            // running: handed a throwaway client, `stop_live` would leave the
            // live loop alive after the session it belongs to was gone.
            signOutEffect: { setup in
                try await sync.signOutHosted(notesRoot: notesRoot, setup: setup)
            },
            connectEffect: { setup in
                await sync.connectHosted(notesRoot: notesRoot, setup: setup)
            }
        )
    }
}

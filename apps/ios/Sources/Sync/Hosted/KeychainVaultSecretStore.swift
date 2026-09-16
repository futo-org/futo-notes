import Foundation

/// Where this device keeps the vault key and the session token: the iOS
/// Keychain, scoped to one notes root.
///
/// The engine names the two secrets and decides when to read or write them
/// (ADR 0003, decision 4); this only says where they live. The vault password
/// is never among them — a device set up by password and one set up by a
/// recovery key are indistinguishable afterwards, and neither is asked for
/// anything again.
///
/// A missing entry is `nil`, never an error, because a device that has not
/// been set up is the ordinary case. A refusal to *keep* a secret is an error,
/// because the alternative is a device that looks set up and is not. UniFFI
/// calls these on Tokio workers, so nothing here touches UI.
final class KeychainVaultSecretStore: VaultSecretStore {
    private let notesRoot: String

    init(notesRoot: String) {
        self.notesRoot = notesRoot
    }

    func vaultKey() throws -> Data? {
        Keychain.vaultKey(notesRoot: notesRoot)
    }

    func setVaultKey(key: Data) throws {
        try refusal { try Keychain.setVaultKey(key, notesRoot: notesRoot) }
    }

    func deleteVaultKey() throws {
        try refusal { try Keychain.deleteVaultKey(notesRoot: notesRoot) }
    }

    func sessionToken() throws -> String? {
        Keychain.sessionToken(notesRoot: notesRoot)
    }

    func setSessionToken(token: String) throws {
        try refusal { try Keychain.setSessionToken(token, notesRoot: notesRoot) }
    }

    func deleteSessionToken() throws {
        try refusal { try Keychain.deleteSessionToken(notesRoot: notesRoot) }
    }

    /// The engine has one variant for every way a secret store can say no,
    /// because there is one thing to do about any of them.
    private func refusal(_ work: () throws -> Void) throws {
        do {
            try work()
        } catch {
            throw SecretStoreError.Refused(reason: "\(error)")
        }
    }
}

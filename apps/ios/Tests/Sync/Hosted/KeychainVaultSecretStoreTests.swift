import Foundation
import Testing

@testable import FutoNotesNative

/// What a hosted device keeps, against the real Keychain.
///
/// This is what makes "never asks for a password again" true: Rust reads these
/// two entries on a cold start and answers `ready` without anything being
/// typed. Each test uses a unique notes root so it cannot collide with — or
/// clobber — the simulator's real entries.
@Suite("Keychain vault secret store")
struct KeychainVaultSecretStoreTests {
    private func uniqueRoot() -> String {
        "/tmp/hosted-tests/\(UUID().uuidString)"
    }

    @Test("an unset device answers nil rather than failing")
    func nothingStoredIsNotAnError() throws {
        let store = KeychainVaultSecretStore(notesRoot: uniqueRoot())
        #expect(try store.vaultKey() == nil)
        #expect(try store.sessionToken() == nil)
    }

    @Test("the vault key and the session token round-trip")
    func roundTrip() throws {
        let root = uniqueRoot()
        let store = KeychainVaultSecretStore(notesRoot: root)
        defer {
            try? store.deleteVaultKey()
            try? store.deleteSessionToken()
        }

        let key = Data((0..<32).map { UInt8($0) })
        try store.setVaultKey(key: key)
        try store.setSessionToken(token: "session-token")

        #expect(try store.vaultKey() == key)
        #expect(try store.sessionToken() == "session-token")

        // A second write replaces rather than duplicating, so a re-unlock does
        // not leave two items one of which is stale.
        let replacement = Data((0..<32).map { UInt8(255 - $0) })
        try store.setVaultKey(key: replacement)
        #expect(try store.vaultKey() == replacement)
    }

    @Test("signing out leaves nothing behind, and doing it twice still succeeds")
    func deleteIsIdempotent() throws {
        let root = uniqueRoot()
        let store = KeychainVaultSecretStore(notesRoot: root)

        try store.setVaultKey(key: Data(repeating: 7, count: 32))
        try store.setSessionToken(token: "session-token")

        try store.deleteVaultKey()
        try store.deleteSessionToken()
        #expect(try store.vaultKey() == nil)
        #expect(try store.sessionToken() == nil)

        try store.deleteVaultKey()
        try store.deleteSessionToken()
    }

    @Test("two vaults on one device never see each other's key")
    func scopedPerNotesRoot() throws {
        let dev = KeychainVaultSecretStore(notesRoot: uniqueRoot())
        let other = KeychainVaultSecretStore(notesRoot: uniqueRoot())
        defer { try? dev.deleteVaultKey() }

        try dev.setVaultKey(key: Data(repeating: 1, count: 32))

        #expect(try other.vaultKey() == nil)
    }

    @Test("a key that is not 32 bytes is refused rather than stored short")
    func wrongLengthIsRefused() {
        let store = KeychainVaultSecretStore(notesRoot: uniqueRoot())
        #expect(throws: (any Error).self) {
            try store.setVaultKey(key: Data(repeating: 1, count: 16))
        }
    }
}

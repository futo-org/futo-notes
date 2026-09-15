import Foundation
import Testing

@testable import FutoNotesNative

/// The keychain accounts the three sync secrets live under. A keychain item is
/// only findable by the exact `(service, account)` it was written with, so these
/// strings are storage compatibility, not cosmetics.
@Suite("Keychain accounts")
struct KeychainAccountTests {
    @Test("the password keeps the bare account name it has always had")
    func passwordAccountIsUnchanged() {
        // Items written by every shipped version live under this exact string.
        // Changing it strands a user's stored password on upgrade.
        #expect(Keychain.Secret.syncPassword.account == "syncPassword")
    }

    @Test("the vault key and the session token are scoped by notes root")
    func newSecretsAreScopedPerVault() {
        let dev = "/var/mobile/Documents/fake-notes"
        let prod = "/var/mobile/Documents/futo-notes"

        #expect(Keychain.Secret.vaultKey(notesRoot: dev).account == "vaultKey:\(dev)")
        #expect(
            Keychain.Secret.sessionToken(notesRoot: dev).account == "sessionToken:\(dev)")

        // The debug/production data split (root AGENTS.md M3): a dev build must
        // never reach the production vault's key.
        #expect(
            Keychain.Secret.vaultKey(notesRoot: dev).account
                != Keychain.Secret.vaultKey(notesRoot: prod).account)
    }

    @Test("the three secrets never collide for one vault")
    func secretsDoNotCollide() {
        let root = "/var/mobile/Documents/fake-notes"
        let accounts = Set([
            Keychain.Secret.syncPassword.account,
            Keychain.Secret.vaultKey(notesRoot: root).account,
            Keychain.Secret.sessionToken(notesRoot: root).account,
        ])
        #expect(accounts.count == 3)
    }
}

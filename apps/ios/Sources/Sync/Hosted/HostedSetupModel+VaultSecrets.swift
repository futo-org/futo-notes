import Foundation

extension HostedSetupModel {
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
}

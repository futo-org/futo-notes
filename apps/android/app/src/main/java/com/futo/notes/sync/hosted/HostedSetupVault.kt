package com.futo.notes.sync.hosted

import com.futo.notes.localization.LocalizedMessage
import uniffi.futo_notes_ffi.HostedException

suspend fun HostedSetupModel.createVault(vaultPassword: String) = step { setup ->
    recoveryKey = setup.createVault(vaultPassword)
    recoveryKeyReplaced = false
    recoveryKeySaved = false
    screen = HostedScreen.RECOVERY_KEY
}

/**
 * Opens the new-password screen. No round trip and no current secret asked:
 * this device holds the vault key already, and a device paired by QR never
 * knew the old password (ADR 0003, decision 10).
 */
fun HostedSetupModel.beginChangeVaultPassword() {
    errorMessage = null
    screen = HostedScreen.CHANGE_VAULT_PASSWORD
}

/**
 * Re-wraps the password envelope and goes back to the account card.
 *
 * Rust re-wraps the same vault key, so every other device carries on with
 * what it already holds and is never told anything happened (parent spec
 * user story 33). A [HostedException.VaultKeyChangedElsewhere] leaves this
 * screen up with that sentence on it, because pressing the button again is
 * the whole remedy.
 */
suspend fun HostedSetupModel.changeVaultPassword(newPassword: String) = step { setup ->
    setup.changeVaultPassword(newPassword)
    shell.announce(LocalizedMessage("sync.hosted.vaultPassword.change.changed"))
    readStep(setup)
}

/**
 * Issues a new recovery key and shows it on the same save screen the wizard
 * uses — the old one has stopped working by the time it appears.
 */
suspend fun HostedSetupModel.newRecoveryKey() = step { setup ->
    recoveryKey = setup.newRecoveryKey()
    recoveryKeyReplaced = true
    recoveryKeySaved = false
    screen = HostedScreen.RECOVERY_KEY
}

/** Leaves an account-card detour without doing anything. */
suspend fun HostedSetupModel.backToAccount() = step { setup -> readStep(setup) }

fun HostedSetupModel.copyRecoveryKey() {
    val key = recoveryKey ?: return
    shell.copyToClipboard(key)
    shell.announce(LocalizedMessage("sync.hosted.recoveryKey.copied"))
}

/** Shares the key and nothing else, so it pastes straight into unlock. */
fun HostedSetupModel.shareRecoveryKey() {
    val key = recoveryKey ?: return
    shell.share(key)
}

suspend fun HostedSetupModel.continueAfterRecoveryKey() {
    recoveryKey = null
    recoveryKeyReplaced = false
    recoveryKeySaved = false
    step { setup -> readStep(setup) }
}

suspend fun HostedSetupModel.unlockWithPassword(vaultPassword: String) = step { setup ->
    setup.unlockWithVaultPassword(vaultPassword)
    readStep(setup)
}

suspend fun HostedSetupModel.unlockWithRecoveryKey(typed: String) = step { setup ->
    setup.unlockWithRecoveryKey(typed)
    readStep(setup)
}

/**
 * Moves the unlock screen to another door, stopping a live pairing wait on
 * the way out. A code that is already on the relay cannot be withdrawn, so
 * leaving abandons it rather than resuming it.
 */
fun HostedSetupModel.chooseDoor(door: UnlockDoor) {
    if (unlockDoor == UnlockDoor.SCAN && door != UnlockDoor.SCAN) cancelPairing()
    unlockDoor = door
}

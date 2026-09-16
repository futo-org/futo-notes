package com.futo.notes.sync.hosted

import com.futo.notes.localization.LocalizedMessage
import uniffi.futo_notes_ffi.HostedException

/**
 * Turns a rejected hosted step into the sentence a person reads.
 *
 * Rust answers with a variant, not a sentence, precisely so each one can be a
 * different thing to do about it — so this is a total `when` over those
 * variants and never a stringified error. Two of them matter more than the
 * rest: `SignInAgain` must read as "sign in again" and never as a broken or
 * reset vault, and `RecoveryKeyTypo` must name the typo rather than claim the
 * key is wrong (parent spec user stories 18 and 22).
 *
 * A hand-written mirror of `src/features/sync/hostedSyncErrors.ts` and
 * `apps/ios/Sources/Sync/Hosted/HostedSyncErrors.swift`, registered in
 * `scripts/drift-registry.json`.
 */
fun hostedErrorMessage(error: Throwable): LocalizedMessage = when (error) {
    is HostedException.SignInAgain -> LocalizedMessage("sync.hosted.errors.signInAgain")
    is HostedException.NotSignedIn -> LocalizedMessage("sync.hosted.errors.notSignedIn")
    is HostedException.NotHosted -> LocalizedMessage("sync.hosted.errors.notHosted")
    is HostedException.RateLimited -> LocalizedMessage(
        "sync.hosted.errors.rateLimited",
        mapOf("seconds" to error.retryAfterSeconds.toLong()),
    )
    is HostedException.Server -> LocalizedMessage("sync.hosted.errors.server")
    is HostedException.Network -> LocalizedMessage("sync.hosted.errors.network")
    is HostedException.NotEntitled -> LocalizedMessage("sync.hosted.errors.notEntitled")
    is HostedException.VaultAlreadyExists ->
        LocalizedMessage("sync.hosted.errors.vaultAlreadyExists")
    is HostedException.NoVault -> LocalizedMessage("sync.hosted.errors.noVault")
    is HostedException.VaultPasswordTooShort -> LocalizedMessage(
        "sync.hosted.errors.vaultPasswordTooShort",
        mapOf("minimum" to error.minimum.toLong()),
    )
    is HostedException.WrongVaultPassword ->
        LocalizedMessage("sync.hosted.errors.wrongVaultPassword")
    is HostedException.RecoveryKeyFormat ->
        LocalizedMessage("sync.hosted.errors.recoveryKeyFormat")
    is HostedException.RecoveryKeyTypo -> LocalizedMessage("sync.hosted.errors.recoveryKeyTypo")
    is HostedException.WrongRecoveryKey ->
        LocalizedMessage("sync.hosted.errors.wrongRecoveryKey")
    is HostedException.NoRecoveryKey -> LocalizedMessage("sync.hosted.errors.noRecoveryKey")
    is HostedException.SecretStore -> LocalizedMessage("sync.hosted.errors.secretStore")
    is HostedException.Crypto -> LocalizedMessage("sync.hosted.errors.crypto")
    is HostedException.PairingCodeInvalid ->
        LocalizedMessage("sync.hosted.errors.pairingCodeInvalid")
    is HostedException.PairingRefused -> LocalizedMessage("sync.hosted.errors.pairingRefused")
    is HostedException.PairingAlreadyKeyed ->
        LocalizedMessage("sync.hosted.errors.pairingAlreadyKeyed")
    is HostedException.PairingExpired -> LocalizedMessage("sync.hosted.errors.pairingExpired")
    is HostedException.PairingNotStarted ->
        LocalizedMessage("sync.hosted.errors.pairingNotStarted")
    is HostedException.VaultLocked -> LocalizedMessage("sync.hosted.errors.vaultLocked")
    // Anything that is not one of the engine's variants — a JNA failure, a
    // coroutine cancellation surfacing as a throwable — says so plainly rather
    // than showing a stack-trace fragment.
    else -> LocalizedMessage("sync.hosted.errors.unexpected")
}

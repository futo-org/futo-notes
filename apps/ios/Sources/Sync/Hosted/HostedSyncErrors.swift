import Foundation

/// Turns a rejected hosted step into the sentence a person reads.
///
/// Rust answers with a variant, not a sentence, precisely so each one can be a
/// different thing to do about it — so this is a total switch over those
/// variants and never a stringified error. Two of them matter more than the
/// rest: `SignInAgain` must read as "sign in again" and never as a broken or
/// reset vault, and `RecoveryKeyTypo` must name the typo rather than claim the
/// key is wrong (parent spec user stories 18 and 22).
///
/// A hand-written mirror of `src/features/sync/hostedSyncErrors.ts`,
/// registered in `scripts/drift-registry.json`.
func hostedErrorMessage(_ error: Error) -> LocalizedMessage {
    guard let hosted = error as? HostedError else {
        return LocalizedMessage("sync.hosted.errors.unexpected")
    }
    switch hosted {
    case .SignInAgain:
        return LocalizedMessage("sync.hosted.errors.signInAgain")
    case .NotSignedIn:
        return LocalizedMessage("sync.hosted.errors.notSignedIn")
    case .NotHosted:
        return LocalizedMessage("sync.hosted.errors.notHosted")
    case .RateLimited(let retryAfterSeconds):
        return LocalizedMessage(
            "sync.hosted.errors.rateLimited",
            arguments: ["seconds": retryAfterSeconds]
        )
    case .Server:
        return LocalizedMessage("sync.hosted.errors.server")
    case .Network:
        return LocalizedMessage("sync.hosted.errors.network")
    case .NotEntitled:
        return LocalizedMessage("sync.hosted.errors.notEntitled")
    case .VaultAlreadyExists:
        return LocalizedMessage("sync.hosted.errors.vaultAlreadyExists")
    case .NoVault:
        return LocalizedMessage("sync.hosted.errors.noVault")
    case .VaultPasswordTooShort(let minimum):
        return LocalizedMessage(
            "sync.hosted.errors.vaultPasswordTooShort",
            arguments: ["minimum": minimum]
        )
    case .WrongVaultPassword:
        return LocalizedMessage("sync.hosted.errors.wrongVaultPassword")
    case .RecoveryKeyFormat:
        return LocalizedMessage("sync.hosted.errors.recoveryKeyFormat")
    case .RecoveryKeyTypo:
        return LocalizedMessage("sync.hosted.errors.recoveryKeyTypo")
    case .WrongRecoveryKey:
        return LocalizedMessage("sync.hosted.errors.wrongRecoveryKey")
    case .NoRecoveryKey:
        return LocalizedMessage("sync.hosted.errors.noRecoveryKey")
    case .SecretStore:
        return LocalizedMessage("sync.hosted.errors.secretStore")
    case .Crypto:
        return LocalizedMessage("sync.hosted.errors.crypto")
    }
}

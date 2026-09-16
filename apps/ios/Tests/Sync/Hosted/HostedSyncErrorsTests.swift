import Foundation
import Testing

@testable import FutoNotesNative

/// Every hosted failure a person acts on differently gets its own sentence.
/// Folding two of them together is the bug this suite exists to catch.
@Suite("Hosted error vocabulary")
struct HostedSyncErrorsTests {
    @Test("an expired session reads as sign in again, never as a broken vault")
    func expiredSessionIsNotAReset() {
        #expect(
            hostedErrorMessage(HostedError.SignInAgain).path == "sync.hosted.errors.signInAgain")
    }

    @Test("a mistyped recovery key is named as a typo, not as a wrong key")
    func typoIsNotAWrongKey() {
        #expect(
            hostedErrorMessage(HostedError.RecoveryKeyTypo).path
                == "sync.hosted.errors.recoveryKeyTypo")
        #expect(
            hostedErrorMessage(HostedError.WrongRecoveryKey).path
                == "sync.hosted.errors.wrongRecoveryKey")
        #expect(
            hostedErrorMessage(HostedError.RecoveryKeyFormat).path
                == "sync.hosted.errors.recoveryKeyFormat")
    }

    @Test("every variant maps to its own message")
    func everyVariantIsDistinct() {
        let errors: [HostedError] = [
            .SignInAgain,
            .NotSignedIn,
            .NotHosted(reason: "no route"),
            .RateLimited(retryAfterSeconds: 30),
            .Server(reason: "boom"),
            .Network(reason: "offline"),
            .NotEntitled,
            .VaultAlreadyExists,
            .NoVault,
            .VaultPasswordTooShort(minimum: 12),
            .WrongVaultPassword,
            .RecoveryKeyFormat,
            .RecoveryKeyTypo,
            .WrongRecoveryKey,
            .NoRecoveryKey,
            .SecretStore(reason: "locked"),
            .Crypto(reason: "bad envelope"),
            .PairingCodeInvalid,
            .PairingRefused,
            .PairingAlreadyKeyed,
            .PairingExpired,
            .PairingNotStarted,
            .VaultLocked,
        ]
        let paths = errors.map { hostedErrorMessage($0).path }
        #expect(Set(paths).count == errors.count)
    }

    /// Each pairing failure is a different thing to do next: scan something
    /// else, show a new code, show one on a device nobody has answered yet, or
    /// unlock this device before giving its key away. Folding them into one
    /// sentence would leave a person re-scanning a code that can never work.
    @Test("each pairing failure says what to do about that failure")
    func pairingFailuresAreDistinct() {
        #expect(
            hostedErrorMessage(HostedError.PairingCodeInvalid).path
                == "sync.hosted.errors.pairingCodeInvalid")
        #expect(
            hostedErrorMessage(HostedError.PairingRefused).path
                == "sync.hosted.errors.pairingRefused")
        #expect(
            hostedErrorMessage(HostedError.PairingAlreadyKeyed).path
                == "sync.hosted.errors.pairingAlreadyKeyed")
        #expect(
            hostedErrorMessage(HostedError.PairingExpired).path
                == "sync.hosted.errors.pairingExpired")
        #expect(
            hostedErrorMessage(HostedError.VaultLocked).path == "sync.hosted.errors.vaultLocked")
    }

    @Test("the two variants that carry a number pass it to the message")
    func numbersReachTheMessage() {
        let rateLimited = hostedErrorMessage(HostedError.RateLimited(retryAfterSeconds: 30))
        #expect(rateLimited.arguments["seconds"] as? UInt32 == 30)

        let tooShort = hostedErrorMessage(HostedError.VaultPasswordTooShort(minimum: 12))
        #expect(tooShort.arguments["minimum"] as? UInt32 == 12)
    }

    @Test("anything that is not a hosted failure still gets a sentence")
    func nonHostedErrorsAreNotSwallowed() {
        struct Boom: Error {}
        #expect(hostedErrorMessage(Boom()).path == "sync.hosted.errors.unexpected")
    }
}

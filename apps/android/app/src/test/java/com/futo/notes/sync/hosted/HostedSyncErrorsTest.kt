package com.futo.notes.sync.hosted

import org.junit.Assert.assertEquals
import org.junit.Test
import uniffi.futo_notes_ffi.HostedException

/**
 * Every hosted failure a person acts on differently gets its own sentence.
 * Folding two of them together is the bug this suite exists to catch.
 */
class HostedSyncErrorsTest {
    @Test
    fun `an expired session reads as sign in again, never as a broken vault`() {
        assertEquals(
            "sync.hosted.errors.signInAgain",
            hostedErrorMessage(HostedException.SignInAgain()).path,
        )
    }

    @Test
    fun `a mistyped recovery key is named as a typo, not as a wrong key`() {
        assertEquals(
            "sync.hosted.errors.recoveryKeyTypo",
            hostedErrorMessage(HostedException.RecoveryKeyTypo()).path,
        )
        assertEquals(
            "sync.hosted.errors.wrongRecoveryKey",
            hostedErrorMessage(HostedException.WrongRecoveryKey()).path,
        )
        assertEquals(
            "sync.hosted.errors.recoveryKeyFormat",
            hostedErrorMessage(HostedException.RecoveryKeyFormat()).path,
        )
    }

    /**
     * The four pairing failures are four different screens: a code that was
     * never a code, one the relay will not serve, one already answered, and one
     * that ran out of time. One sentence for all of them would leave a person
     * showing a new code when the real problem is that they scanned a receipt.
     */
    @Test
    fun `each pairing failure keeps its own sentence`() {
        assertEquals(
            "sync.hosted.errors.pairingCodeInvalid",
            hostedErrorMessage(HostedException.PairingCodeInvalid()).path,
        )
        assertEquals(
            "sync.hosted.errors.pairingRefused",
            hostedErrorMessage(HostedException.PairingRefused()).path,
        )
        assertEquals(
            "sync.hosted.errors.pairingAlreadyKeyed",
            hostedErrorMessage(HostedException.PairingAlreadyKeyed()).path,
        )
        assertEquals(
            "sync.hosted.errors.pairingExpired",
            hostedErrorMessage(HostedException.PairingExpired()).path,
        )
        assertEquals(
            "sync.hosted.errors.vaultLocked",
            hostedErrorMessage(HostedException.VaultLocked()).path,
        )
    }

    @Test
    fun `every variant maps to its own message`() {
        val errors = everyVariant()
        val paths = errors.map { hostedErrorMessage(it).path }
        assertEquals(errors.size, paths.toSet().size)
    }

    @Test
    fun `the two variants that carry a number pass it to the message`() {
        assertEquals(
            30L,
            hostedErrorMessage(HostedException.RateLimited(30u)).arguments["seconds"],
        )
        assertEquals(
            12L,
            hostedErrorMessage(HostedException.VaultPasswordTooShort(12u)).arguments["minimum"],
        )
    }

    @Test
    fun `anything that is not a hosted failure still gets a sentence`() {
        assertEquals(
            "sync.hosted.errors.unexpected",
            hostedErrorMessage(IllegalStateException("boom")).path,
        )
    }

    /**
     * Named individually rather than reflected over, so adding a variant to the
     * engine without a sentence here fails to compile rather than passing
     * quietly.
     */
    private fun everyVariant(): List<HostedException> = listOf(
        HostedException.SignInAgain(),
        HostedException.NotSignedIn(),
        HostedException.NotHosted("no route"),
        HostedException.RateLimited(30u),
        HostedException.Server("boom"),
        HostedException.Network("offline"),
        HostedException.NotEntitled(),
        HostedException.VaultAlreadyExists(),
        HostedException.NoVault(),
        HostedException.VaultPasswordTooShort(12u),
        HostedException.WrongVaultPassword(),
        HostedException.RecoveryKeyFormat(),
        HostedException.RecoveryKeyTypo(),
        HostedException.WrongRecoveryKey(),
        HostedException.NoRecoveryKey(),
        HostedException.SecretStore("locked"),
        HostedException.Crypto("bad envelope"),
        HostedException.PairingCodeInvalid(),
        HostedException.PairingRefused(),
        HostedException.PairingAlreadyKeyed(),
        HostedException.PairingExpired(),
        HostedException.PairingNotStarted(),
        HostedException.VaultLocked(),
    )
}

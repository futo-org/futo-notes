package com.futo.notes.sync.hosted

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * The estimate the create-vault screen shows. What it has to get right is
 * narrow: reward length and variety, and refuse to call a long repeated
 * character strong. Rust owns the 12-character rule; this is advice on top.
 *
 * The cases mirror `vaultPasswordStrength.test.ts` and
 * `VaultPasswordStrengthTests.swift` — the three copies are an unlocked drift
 * entry, so they have to agree on the same inputs.
 */
class VaultPasswordStrengthTest {
    @Test
    fun `anything shorter than the engine's minimum is too short`() {
        assertEquals(VaultPasswordStrength.TOO_SHORT, vaultPasswordStrength("short", MINIMUM))
        assertEquals(VaultPasswordStrength.TOO_SHORT, vaultPasswordStrength("elevenchars", MINIMUM))
        assertEquals(VaultPasswordStrength.TOO_SHORT, vaultPasswordStrength("", MINIMUM))
        // However varied.
        assertEquals(VaultPasswordStrength.TOO_SHORT, vaultPasswordStrength("Tr0ub4&or", MINIMUM))
    }

    @Test
    fun `a long repeated character is never better than weak`() {
        assertEquals(VaultPasswordStrength.WEAK, vaultPasswordStrength("a".repeat(16), MINIMUM))
        assertEquals(VaultPasswordStrength.WEAK, vaultPasswordStrength("ab".repeat(20), MINIMUM))
    }

    @Test
    fun `length and variety earn fair, then strong`() {
        assertEquals(VaultPasswordStrength.FAIR, vaultPasswordStrength("correcthorse", MINIMUM))
        assertEquals(
            VaultPasswordStrength.STRONG,
            vaultPasswordStrength("correct-horse-Battery-9-staple", MINIMUM),
        )
    }

    @Test
    fun `the minimum is the caller's, not a constant in here`() {
        assertNotEquals(VaultPasswordStrength.TOO_SHORT, vaultPasswordStrength("eightchr", 8))
        assertEquals(VaultPasswordStrength.TOO_SHORT, vaultPasswordStrength("eightchr", MINIMUM))
    }

    @Test
    fun `length is counted in code points, as Rust counts chars`() {
        // Twelve emoji are twelve code points even though `length` says 24.
        // Counting UTF-16 units would accept eleven, which Rust then refuses.
        assertEquals(24, "🙂".repeat(12).length)
        assertNotEquals(
            VaultPasswordStrength.TOO_SHORT,
            vaultPasswordStrength("🙂".repeat(12), MINIMUM),
        )
        assertEquals(
            VaultPasswordStrength.TOO_SHORT,
            vaultPasswordStrength("🙂".repeat(11), MINIMUM),
        )
    }

    private companion object {
        const val MINIMUM = 12
    }
}

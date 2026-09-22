import Testing

@testable import FutoNotesNative

/// The estimate the create-vault screen shows. What it has to get right is
/// narrow: reward length and variety, and refuse to call a long repeated
/// character strong.
@Suite("Vault password strength")
struct VaultPasswordStrengthTests {
    @Test("anything shorter than the engine's minimum is too short")
    func belowTheMinimum() {
        #expect(vaultPasswordStrength("short", minimumLength: 12) == .tooShort)
        #expect(vaultPasswordStrength("elevenchars", minimumLength: 12) == .tooShort)
        #expect(vaultPasswordStrength("", minimumLength: 12) == .tooShort)
    }

    @Test("a long repeated character is never better than weak")
    func repetitionIsNotLength() {
        #expect(
            vaultPasswordStrength(String(repeating: "a", count: 16), minimumLength: 12) == .weak)
        #expect(
            vaultPasswordStrength(String(repeating: "ab", count: 20), minimumLength: 12) == .weak)
    }

    @Test("length and variety earn fair, then strong")
    func varietyAndLength() {
        #expect(vaultPasswordStrength("correcthorse", minimumLength: 12) == .fair)
        #expect(
            vaultPasswordStrength("correct-horse-Battery-9-staple", minimumLength: 12) == .strong)
    }

    @Test("the minimum is the caller's, not a constant in here")
    func theMinimumIsAParameter() {
        #expect(vaultPasswordStrength("eightchr", minimumLength: 8) != .tooShort)
        #expect(vaultPasswordStrength("eightchr", minimumLength: 12) == .tooShort)
    }

    @Test("length is counted in Unicode scalars, as Rust counts it")
    func scalarsNotGraphemes() {
        // Rust refuses a vault password shorter than MIN_VAULT_PASSWORD_CHARS
        // `chars()`, so the meter must not call something long enough that Rust
        // would reject — or short when Rust would accept.
        let twelveScalars = "ábcdefghijkl"
        #expect(twelveScalars.unicodeScalars.count == 12)
        #expect(vaultPasswordStrength(twelveScalars, minimumLength: 12) != .tooShort)
    }
}

import Foundation

/// The strength estimate shown while a person chooses a vault password.
///
/// Length is the only *rule* — Rust owns the 12-character minimum and there
/// are no composition rules (ADR 0003, decision 7). This is advice on top of
/// it, and deliberately a small local estimate rather than a password-strength
/// library: zxcvbn and its ports carry a multi-hundred-kilobyte dictionary,
/// and this is the only screen in the app that would ever ask.
///
/// A hand-written mirror of `src/features/sync/vaultPasswordStrength.ts`,
/// registered in `scripts/drift-registry.json`. It counts Unicode scalars, not
/// grapheme clusters, because that is what both the TypeScript copy
/// (`[...password]`) and Rust's own minimum (`chars().count()`) count.
enum VaultPasswordStrength: String {
    case tooShort
    case weak
    case fair
    case strong
}

/// Size of each character pool a password draws from.
private let pools: [(contains: (Unicode.Scalar) -> Bool, size: Double)] = [
    ({ $0 >= "a" && $0 <= "z" }, 26),
    ({ $0 >= "A" && $0 <= "Z" }, 26),
    ({ $0 >= "0" && $0 <= "9" }, 10),
    ({ !(($0 >= "a" && $0 <= "z") || ($0 >= "A" && $0 <= "Z") || ($0 >= "0" && $0 <= "9")) }, 33),
]

private let fairBits = 45.0
private let strongBits = 70.0

func vaultPasswordStrength(_ password: String, minimumLength: Int) -> VaultPasswordStrength {
    let scalars = Array(password.unicodeScalars)
    if scalars.count < minimumLength { return .tooShort }

    let bits = estimatedBits(scalars)
    if bits >= strongBits { return .strong }
    if bits >= fairBits { return .fair }
    return .weak
}

/// Roughly how much guessing this password costs: its length against the pools
/// it draws from, with length capped at twice the number of distinct
/// characters. That cap is what stops sixteen identical letters — long enough
/// to pass the minimum — from being reported as anything but weak, while
/// leaving an ordinary password's length untouched.
private func estimatedBits(_ scalars: [Unicode.Scalar]) -> Double {
    let pool = pools.reduce(0.0) { total, entry in
        scalars.contains(where: entry.contains) ? total + entry.size : total
    }
    if pool == 0 { return 0 }
    let distinct = Set(scalars).count
    let effectiveLength = Double(min(scalars.count, distinct * 2))
    return effectiveLength * log2(pool)
}

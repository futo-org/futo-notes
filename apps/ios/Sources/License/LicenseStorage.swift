import Foundation

/// Where the two plain strings of a license live on iOS.
///
/// `UserDefaults`, not the vault (it would sync and surface as a note) and not
/// the Keychain (a license is a receipt, not a secret) — docs/spec/license.md
/// § Storage. `UserDefaults.standard` is scoped to the bundle id, so the
/// dev/prod split (M3) is the app sandbox itself: `com.futo.notes.dev` cannot
/// see the release app's license, or the other way round.
///
/// This type stores and returns both strings **verbatim**. base64url is
/// case-sensitive and the activation is signed bytes, so anything that
/// "tidies" it on the way through stops the license verifying.
struct LicenseStorage {
    static let keyDefaultsKey = "futo.license.key"
    static let activationDefaultsKey = "futo.license.activation"

    private let defaults: LicenseDefaults

    init(defaults: LicenseDefaults = UserDefaults.standard) {
        self.defaults = defaults
    }

    /// Both strings, or nothing at all. A half-written pair can never verify,
    /// so it reads as "no license" rather than as a pair that fails an RSA
    /// check on every launch.
    func read() -> LicensePair? {
        guard let key = defaults.string(forKey: Self.keyDefaultsKey),
            let activation = defaults.string(forKey: Self.activationDefaultsKey),
            !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            !activation.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return nil }
        return LicensePair(key: key, activation: activation)
    }

    func write(_ pair: LicensePair) {
        defaults.set(pair.key, forKey: Self.keyDefaultsKey)
        defaults.set(pair.activation, forKey: Self.activationDefaultsKey)
    }

    /// Removing a license that was never stored is the state the user asked
    /// for, not a failure — so this is idempotent. Full reset calls it too.
    func clear() {
        defaults.removeObject(forKey: Self.keyDefaultsKey)
        defaults.removeObject(forKey: Self.activationDefaultsKey)
    }
}

/// The slice of `UserDefaults` a license needs.
///
/// It exists so tests can hand the storage an in-memory store instead of a
/// `UserDefaults(suiteName:)`, which would leave a plist behind in the app
/// container and cannot be shared by tests running in parallel. The signatures
/// are `UserDefaults`' own, so the conformance below is the whole binding —
/// there is no adapter to get wrong, and the real persistence is exercised on
/// device (docs/spec/license.md § Storage).
protocol LicenseDefaults: AnyObject {
    func string(forKey defaultName: String) -> String?
    func set(_ value: Any?, forKey defaultName: String)
    func removeObject(forKey defaultName: String)
}

extension UserDefaults: LicenseDefaults {}

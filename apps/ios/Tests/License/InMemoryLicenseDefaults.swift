import Foundation

@testable import FutoNotesNative

/// An in-memory stand-in for `UserDefaults`, so no test can read or write the
/// simulator's real license — and so a test run leaves nothing behind in the
/// app container (a `UserDefaults(suiteName:)` writes a plist there that
/// outlives `removePersistentDomain`).
final class InMemoryLicenseDefaults: LicenseDefaults, @unchecked Sendable {
    private var values: [String: String] = [:]
    private(set) var readOccurredOnMainThread = false

    func string(forKey defaultName: String) -> String? {
        if Thread.isMainThread { readOccurredOnMainThread = true }
        return values[defaultName]
    }

    func set(_ value: Any?, forKey defaultName: String) {
        guard let string = value as? String else {
            values.removeValue(forKey: defaultName)
            return
        }
        values[defaultName] = string
    }

    func removeObject(forKey defaultName: String) {
        values.removeValue(forKey: defaultName)
    }
}

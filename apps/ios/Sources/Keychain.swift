import Foundation
import Security

/// Minimal Keychain-backed store for the single sync password.
///
/// The Rust `SyncClient` session (auth token + vault key) lives in memory only,
/// so a force-quit / cold relaunch loses it. Persisting the password lets the app
/// auto-reconnect on launch (`SyncManager.restoreSession`) and resume live sync
/// without the user re-entering it.
///
/// Tradeoff: an on-device password weakens E2EE (device compromise → password →
/// vault key). Stored as a generic-password item with
/// `kSecAttrAccessibleWhenUnlocked` (readable only while the device is unlocked).
/// Cleared on explicit `disconnect()`.
enum Keychain {
    // Config-separated service string so dev and prod sync credentials never
    // collide (F10). Debug builds (FUTO_DEBUG_BUILD, set only by the Debug config
    // in project.yml) use the .dev service; Release uses the prod string
    // unchanged. Mirrors the dev/prod bundle-id + data-root + entitlement split.
    #if FUTO_DEBUG_BUILD
    private static let service = "com.futo.notes.native.dev.sync"
    #else
    private static let service = "com.futo.notes.native.sync"
    #endif
    private static let account = "syncPassword"

    /// The persisted sync password, or `nil` if none is stored. Setting `nil`
    /// removes the item.
    static var syncPassword: String? {
        get { read() }
        set {
            if let value = newValue { write(value) } else { delete() }
        }
    }

    private static func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private static func read() -> String? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess else {
            // errSecItemNotFound (-25300) is normal (nothing stored yet). Anything
            // else — e.g. -34018 (missing entitlement on an unsigned build) — is a
            // real failure worth surfacing rather than silently swallowing.
            if status != errSecItemNotFound { NSLog("[Keychain] read failed: \(status)") }
            return nil
        }
        guard let data = item as? Data, let password = String(data: data, encoding: .utf8) else {
            return nil
        }
        return password
    }

    private static func write(_ value: String) {
        // Replace any existing item so the latest password always wins.
        SecItemDelete(baseQuery() as CFDictionary)
        var query = baseQuery()
        query[kSecValueData as String] = Data(value.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlocked
        let status = SecItemAdd(query as CFDictionary, nil)
        if status != errSecSuccess { NSLog("[Keychain] write failed: \(status)") }
    }

    private static func delete() {
        SecItemDelete(baseQuery() as CFDictionary)
    }
}

import Foundation
import Security

/// Keychain-backed store for this device's sync secrets: the sync password, the
/// 32-byte vault key, and the session token.
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
///
/// The vault key and session token have no caller yet. They exist because the
/// hosted flow holds a vault key instead of a password (ADR 0003), and the other
/// two shells — the desktop keyring and Android `SecureStore` — grew the same
/// three operations in the same change.
enum Keychain {
    // Config-separated service string so dev and prod sync credentials never
    // collide (F10). Debug builds (FUTO_DEBUG_BUILD, set only by the Debug config
    // in project.yml) use the .dev service; Release uses the prod string
    // unchanged. Mirrors the dev/prod bundle-id + data-root + entitlement split.
    #if FUTO_DEBUG_BUILD
        private static let defaultService = "com.futo.notes.dev.sync"
    #else
        private static let defaultService = "com.futo.notes.sync"
    #endif
    private static var service: String {
        AppLaunchConfiguration.keychainService(defaultService: defaultService)
    }

    /// Which secret an item holds, and the keychain account it lives under.
    ///
    /// The password keeps the bare account name it has always had, so items
    /// written by earlier versions keep resolving. The two newer secrets are
    /// scoped by notes root, because a device can hold a key for one vault while
    /// a `FUTO_NOTES_DATA_DIR` override points the app at another.
    enum Secret {
        case syncPassword
        case vaultKey(notesRoot: String)
        case sessionToken(notesRoot: String)

        var account: String {
            switch self {
            case .syncPassword: return "syncPassword"
            case .vaultKey(let notesRoot): return "vaultKey:\(notesRoot)"
            case .sessionToken(let notesRoot): return "sessionToken:\(notesRoot)"
            }
        }
    }

    /// Bytes in a vault key — the symmetric key the sync engine encrypts notes
    /// with. A stored item of any other length is refused rather than returned.
    static let vaultKeyByteCount = 32

    /// The persisted sync password, or `nil` if none is stored. Setting `nil`
    /// removes the item.
    static var syncPassword: String? {
        get { readString(.syncPassword) }
        set {
            if let value = newValue {
                writeString(value, .syncPassword)
            } else {
                delete(.syncPassword)
            }
        }
    }

    // ── Vault key ────────────────────────────────────────────────────────

    /// The stored vault key for `notesRoot`, or `nil` if none is stored or the
    /// stored item is not exactly `vaultKeyByteCount` bytes.
    static func vaultKey(notesRoot: String) -> Data? {
        guard let data = read(.vaultKey(notesRoot: notesRoot)) else { return nil }
        guard data.count == vaultKeyByteCount else {
            NSLog(
                "[Keychain] stored vault key is \(data.count) bytes, "
                    + "expected \(vaultKeyByteCount)")
            return nil
        }
        return data
    }

    static func setVaultKey(_ key: Data, notesRoot: String) {
        guard key.count == vaultKeyByteCount else {
            NSLog("[Keychain] refusing to store a \(key.count)-byte vault key")
            return
        }
        write(key, .vaultKey(notesRoot: notesRoot))
    }

    static func deleteVaultKey(notesRoot: String) {
        delete(.vaultKey(notesRoot: notesRoot))
    }

    // ── Session token ────────────────────────────────────────────────────

    static func sessionToken(notesRoot: String) -> String? {
        readString(.sessionToken(notesRoot: notesRoot))
    }

    static func setSessionToken(_ token: String, notesRoot: String) {
        writeString(token, .sessionToken(notesRoot: notesRoot))
    }

    static func deleteSessionToken(notesRoot: String) {
        delete(.sessionToken(notesRoot: notesRoot))
    }

    // ── Keychain plumbing ────────────────────────────────────────────────

    private static func baseQuery(_ secret: Secret) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: secret.account,
        ]
    }

    private static func read(_ secret: Secret) -> Data? {
        var query = baseQuery(secret)
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
        return item as? Data
    }

    private static func readString(_ secret: Secret) -> String? {
        guard let data = read(secret) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func write(_ value: Data, _ secret: Secret) {
        // Replace any existing item so the latest secret always wins.
        SecItemDelete(baseQuery(secret) as CFDictionary)
        var query = baseQuery(secret)
        query[kSecValueData as String] = value
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlocked
        let status = SecItemAdd(query as CFDictionary, nil)
        if status != errSecSuccess { NSLog("[Keychain] write failed: \(status)") }
    }

    private static func writeString(_ value: String, _ secret: Secret) {
        write(Data(value.utf8), secret)
    }

    private static func delete(_ secret: Secret) {
        SecItemDelete(baseQuery(secret) as CFDictionary)
    }
}

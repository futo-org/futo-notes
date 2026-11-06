#if FUTO_DEBUG_BUILD
    import Foundation

    /// Which editor a note opens in (dev builds only; mirrors Android's `TextFirstFlag.kt`).
    /// The choice persists: launch once with `-futo.textFirstEditor YES` (or `NO`) and it stays
    /// until set again. Off by default, so the WKWebView editor remains the default.
    enum TextFirstFlag {
        static let key = "futo.textFirstEditor"

        /// The persisted value; release builds never reach this file.
        static func enabled(defaults: UserDefaults = .standard) -> Bool {
            defaults.bool(forKey: key)
        }

        /// Persist the launch argument's choice, if it carries one. `-futo.textFirstEditor YES`
        /// lands in the NSArgumentDomain, which does not survive the next launch by itself.
        static func readLaunchArguments(
            _ arguments: [String] = ProcessInfo.processInfo.arguments,
            defaults: UserDefaults = .standard
        ) {
            guard let at = arguments.firstIndex(of: "-" + key), arguments.indices.contains(at + 1)
            else { return }
            let value = arguments[at + 1].uppercased()
            defaults.set(["YES", "TRUE", "1"].contains(value), forKey: key)
        }
    }
#endif

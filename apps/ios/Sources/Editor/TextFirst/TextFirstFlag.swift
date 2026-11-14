import Foundation

/// Release always uses the native editor. Debug retains the persisted comparison switch.
enum TextFirstFlag {
    static let key = "futo.textFirstEditor"

    /// Debug can select Milkdown for compatibility checks; preferences cannot disable native in Release.
    static func enabled(defaults: UserDefaults = .standard) -> Bool {
        #if FUTO_DEBUG_BUILD
            defaults.bool(forKey: key)
        #else
            true
        #endif
    }

    /// Persist the launch argument's choice, if it carries one. `-futo.textFirstEditor YES`
    /// lands in the NSArgumentDomain, which does not survive the next launch by itself.
    #if FUTO_DEBUG_BUILD
        static func readLaunchArguments(
            _ arguments: [String] = ProcessInfo.processInfo.arguments,
            defaults: UserDefaults = .standard
        ) {
            guard let at = arguments.firstIndex(of: "-" + key), arguments.indices.contains(at + 1)
            else { return }
            let value = arguments[at + 1].uppercased()
            defaults.set(["YES", "TRUE", "1"].contains(value), forKey: key)
        }
    #endif
}

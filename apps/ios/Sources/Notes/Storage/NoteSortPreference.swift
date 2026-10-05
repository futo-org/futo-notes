import Foundation

enum NoteSortPreference {
    static let storageKey = "futo.noteSortOrder"

    static let fallback = NoteSortOrder(key: .lastModified, direction: .descending)

    static func stored(in defaults: UserDefaults = .standard) -> NoteSortOrder {
        resolve(defaults.string(forKey: storageKey) ?? "")
    }

    static func store(_ order: NoteSortOrder, in defaults: UserDefaults = .standard) {
        defaults.set(rawValue(order), forKey: storageKey)
    }

    static func rawValue(_ order: NoteSortOrder) -> String {
        "\(name(order.key)):\(name(order.direction))"
    }

    static func resolve(_ rawValue: String) -> NoteSortOrder {
        let parts = rawValue.split(separator: ":", maxSplits: 1)
        guard parts.count == 2,
            let key = key(named: String(parts[0])),
            let direction = direction(named: String(parts[1]))
        else { return fallback }
        return NoteSortOrder(key: key, direction: direction)
    }

    static func directions(for key: NoteSortKey) -> [SortDirection] {
        key == .name ? [.ascending, .descending] : [.descending, .ascending]
    }

    static func withKey(_ key: NoteSortKey, keepingPositionOf order: NoteSortOrder) -> NoteSortOrder
    {
        let position = directions(for: order.key).firstIndex(of: order.direction) ?? 0
        return NoteSortOrder(key: key, direction: directions(for: key)[position])
    }

    static func keyLabelPath(_ key: NoteSortKey) -> String {
        key == .name ? "notes.sort.name" : "notes.sort.lastModified"
    }

    static func directionLabelPath(_ key: NoteSortKey, _ direction: SortDirection) -> String {
        switch (key, direction) {
        case (.name, .ascending): return "notes.sort.aToZ"
        case (.name, .descending): return "notes.sort.zToA"
        case (.lastModified, .descending): return "notes.sort.newest"
        case (.lastModified, .ascending): return "notes.sort.oldest"
        }
    }

    private static func name(_ key: NoteSortKey) -> String {
        key == .name ? "name" : "lastModified"
    }

    private static func name(_ direction: SortDirection) -> String {
        direction == .ascending ? "ascending" : "descending"
    }

    private static func key(named name: String) -> NoteSortKey? {
        switch name {
        case "name": return .name
        case "lastModified": return .lastModified
        default: return nil
        }
    }

    private static func direction(named name: String) -> SortDirection? {
        switch name {
        case "ascending": return .ascending
        case "descending": return .descending
        default: return nil
        }
    }
}

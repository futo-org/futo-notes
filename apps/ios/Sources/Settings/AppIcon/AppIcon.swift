import Foundation

enum AppIcon: String, CaseIterable, Identifiable {
    case lightStandard = "light-standard"
    case lightReversed = "light-reversed"
    case darkStandard = "dark-standard"
    case darkReversed = "dark-reversed"
    case futo
    case website

    var id: String { rawValue }
    var assetName: String {
        switch self {
        case .lightStandard: "LightStandard"
        case .lightReversed: "LightReversed"
        case .darkStandard: "DarkStandard"
        case .darkReversed: "DarkReversed"
        case .futo: "Futo"
        case .website: "Website"
        }
    }
    var alternateName: String? { self == .lightStandard ? nil : "AppIcon" + assetName }
    var previewName: String { "AppIconPreview" + assetName }
    var labelKey: String {
        "settings.appIcon.choices." + assetName.prefix(1).lowercased() + assetName.dropFirst()
    }
    static func from(alternateName: String?) -> AppIcon? {
        allCases.first { $0.alternateName == alternateName }
    }
}

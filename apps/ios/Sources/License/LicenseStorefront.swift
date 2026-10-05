import Combine
import StoreKit

/// Observes the App Store storefront for the life of the app. The initial
/// answer is key-only until StoreKit supplies a country.
@MainActor final class LicenseStorefront: ObservableObject {
    @Published private(set) var linkOut = false

    func observe() async {
        #if FUTO_DEBUG_BUILD
        if let override = Self.debugCountryOverride(ProcessInfo.processInfo.arguments) {
            linkOut = licenseLinkOut(platform: .ios, storefrontCountry: override, buildAllows: true)
            return
        }
        #endif

        linkOut = licenseLinkOut(
            platform: .ios, storefrontCountry: await Storefront.current?.countryCode,
            buildAllows: true)
        for await storefront in Storefront.updates {
            linkOut = licenseLinkOut(
                platform: .ios, storefrontCountry: storefront.countryCode, buildAllows: true)
        }
    }

    #if FUTO_DEBUG_BUILD
    /// QA may choose a country without signing a simulator into an App Store account.
    static func debugCountryOverride(_ arguments: [String]) -> String?? {
        guard let flag = arguments.firstIndex(of: "-FUTOLicenseStorefront"),
              arguments.indices.contains(flag + 1) else { return nil }
        let value = arguments[flag + 1]
        guard ["USA", "FRA", "none"].contains(value) else { return nil }
        return .some(value == "none" ? nil : value)
    }
    #endif
}

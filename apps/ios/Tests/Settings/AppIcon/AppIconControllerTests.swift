import Testing
import UIKit
@testable import FutoNotesNative

@MainActor
@Suite("App icons")
struct AppIconControllerTests {
    final class Icons: AppIconSystem {
        var supportsAlternateIcons = true
        var alternateIconName: String?
        var calls: [String?] = []
        var fail = false
        var beforeCompletion: (() async -> Void)?
        func setAlternateIconName(_ name: String?) async throws {
            calls.append(name)
            await beforeCompletion?()
            if fail { throw Failure.os }
            alternateIconName = name
        }
        enum Failure: Error { case os }
    }
    @Test func bundlesEveryAlternateForIPhoneAndIPad() throws {
        let expected = Set(AppIcon.allCases.compactMap(\.alternateName))
        let files = try FileManager.default.contentsOfDirectory(atPath: Bundle.main.bundlePath)
        for family in ["CFBundleIcons", "CFBundleIcons~ipad"] {
            let icons = try #require(Bundle.main.infoDictionary?[family] as? [String: Any])
            let alternates = try #require(icons["CFBundleAlternateIcons"] as? [String: Any])
            #expect(Set(alternates.keys) == expected)
            for name in expected {
                let definition = try #require(alternates[name] as? [String: Any])
                #expect(definition["CFBundleIconName"] as? String == name)
                // Current Xcode stores icons in Assets.car. Older compilers also
                // expose PNG filenames; verify those whenever they are emitted.
                #expect(files.contains("Assets.car"))
                if let resources = definition["CFBundleIconFiles"] as? [String] {
                    #expect(!resources.isEmpty)
                    for resource in resources {
                        #expect(files.contains { $0.hasPrefix(resource) && $0.hasSuffix(".png") })
                    }
                }
            }
        }
        for icon in AppIcon.allCases {
            #expect(UIImage(named: icon.previewName) != nil)
        }
    }

    @Test func mapsEveryNameAndPrimary() {
        for icon in AppIcon.allCases {
            #expect(AppIcon.from(alternateName: icon.alternateName) == icon)
        }
        #expect(AppIcon.lightStandard.alternateName == nil)
        #expect(AppIcon.from(alternateName: "unknown") == nil)
    }
    @Test func readsOSAndSameSelectionDoesNothing() async {
        let icons = Icons()
        icons.alternateIconName = AppIcon.futo.alternateName
        let controller = AppIconController(system: icons)
        #expect(controller.selected == .futo)
        await controller.select(.futo)
        #expect(icons.calls.isEmpty)
        await controller.select(.website)
        #expect(controller.selected == .website)
        #expect(!controller.failed)
        try? await controller.reset()
        #expect(controller.selected == .lightStandard)
        #expect(icons.alternateIconName == nil)
    }
    @Test func failureRetainsReadbackAndAllowsRetry() async {
        let icons = Icons()
        let controller = AppIconController(system: icons)
        icons.fail = true
        await controller.select(.darkStandard)
        #expect(controller.selected == .lightStandard)
        #expect(controller.failed)
        #expect(!controller.changing)
        icons.fail = false
        await controller.select(.darkStandard)
        #expect(controller.selected == .darkStandard)
        #expect(!controller.failed)
    }
    @Test func ignoresOverlappingRequest() async {
        let icons = Icons()
        let controller = AppIconController(system: icons)
        icons.beforeCompletion = {
            #expect(controller.changing)
            #expect(controller.selected == .lightStandard)
            await controller.select(.website)
        }
        await controller.select(.futo)
        #expect(icons.calls.count == 1)
        #expect(controller.selected == .futo)
    }
    @Test func unsupportedNeverCallsOS() async {
        let icons = Icons()
        icons.supportsAlternateIcons = false
        let controller = AppIconController(system: icons)
        await controller.select(.futo)
        #expect(icons.calls.isEmpty)
        #expect(controller.failed)
    }
}

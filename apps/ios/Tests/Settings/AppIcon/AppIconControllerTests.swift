import Testing
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

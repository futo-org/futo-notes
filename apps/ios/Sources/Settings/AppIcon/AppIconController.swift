import Observation
import OSLog
import UIKit

@MainActor
protocol AppIconSystem {
    var supportsAlternateIcons: Bool { get }
    var alternateIconName: String? { get }
    func setAlternateIconName(_ name: String?) async throws
}

@MainActor
private struct UIKitAppIcons: AppIconSystem {
    var supportsAlternateIcons: Bool { UIApplication.shared.supportsAlternateIcons }
    var alternateIconName: String? { UIApplication.shared.alternateIconName }
    func setAlternateIconName(_ name: String?) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            UIApplication.shared.setAlternateIconName(name) { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume() }
            }
        }
    }
}

@MainActor
@Observable
final class AppIconController {
    private let logger = Logger(subsystem: "com.futo.notes", category: "app-icon")
    private let system: any AppIconSystem
    private(set) var selected: AppIcon = .lightStandard
    private(set) var changing = false
    private(set) var failed = false
    var available: Bool { system.supportsAlternateIcons }

    init(system: (any AppIconSystem)? = nil) {
        self.system = system ?? UIKitAppIcons()
        refresh()
    }

    func refresh() {
        if let actual = AppIcon.from(alternateName: system.alternateIconName) {
            selected = actual
        } else {
            failed = true
        }
    }

    func select(_ icon: AppIcon) async {
        guard !changing else { return }
        refresh()
        guard icon != selected else { failed = false; return }
        guard available else { failed = true; return }
        changing = true
        failed = false
        defer { changing = false }
        do {
            try await system.setAlternateIconName(icon.alternateName)
            refresh()
            failed = selected != icon
        } catch {
            logger.error("App icon change failed: \(String(describing: error), privacy: .public)")
            refresh()
            failed = true
        }
    }

    func reset() async throws {
        await select(.lightStandard)
        guard !failed, selected == .lightStandard else { throw IconResetFailure.failed }
    }
    private enum IconResetFailure: Error { case failed }
}

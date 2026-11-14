import SwiftUI

@MainActor
final class EditorToolbarState: ObservableObject {
    @Published var onListLine = false
    @Published var inContainer: Bool?
    @Published var activeFormats: Set<String> = []
    @Published var disabledFormats: Set<String> = []
}

@MainActor
final class EditorToolbarLocalization: ObservableObject {
    @Published var localization: Localization

    init(_ localization: Localization) {
        self.localization = localization
    }

    func update(_ localization: Localization) {
        guard self.localization !== localization else { return }
        self.localization = localization
    }
}

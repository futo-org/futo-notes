import Testing
import UIKit

@testable import FutoNotesNative

@Suite("Theme mode")
struct ThemeModeTests {
    @Test("stored raw values map to interface styles")
    func interfaceStyles() {
        #expect(ThemeMode.resolve("light").interfaceStyle == .light)
        #expect(ThemeMode.resolve("dark").interfaceStyle == .dark)
        #expect(ThemeMode.resolve("auto").interfaceStyle == .unspecified)
    }

    @Test("an unknown or missing stored value falls back to auto")
    func unknownValueFallsBackToAuto() {
        #expect(ThemeMode.resolve("") == .auto)
        #expect(ThemeMode.resolve("system") == .auto)
    }

    @Test("the storage key stays the shipped futo.themeMode key")
    func storageKeyIsStable() {
        #expect(ThemeMode.storageKey == "futo.themeMode")
    }
}

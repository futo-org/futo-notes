import XCTest

final class ThemeSwitchTests: XCTestCase {
    @MainActor
    func testOpenSettingsSheetFollowsEveryThemeChange() {
        XCUIDevice.shared.appearance = .light
        let app = makeIsolatedApplication()
        app.launch()

        let settingsButton = app.buttons["nav-settings"]
        XCTAssertTrue(settingsButton.waitForExistence(timeout: 20))
        settingsButton.tap()

        let settingsBar = app.navigationBars["Settings"]
        XCTAssertTrue(settingsBar.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Dark"].waitForExistence(timeout: 5))

        app.buttons["Dark"].tap()
        XCTAssertTrue(
            waitForSheet(settingsBar, dark: true),
            "Settings sheet did not turn dark while it was open")

        app.buttons["Light"].tap()
        XCTAssertTrue(
            waitForSheet(settingsBar, dark: false),
            "Settings sheet stayed dark after switching to Light")

        app.buttons["Dark"].tap()
        XCTAssertTrue(
            waitForSheet(settingsBar, dark: true),
            "Settings sheet did not turn dark again")

        app.buttons["Auto"].tap()
        XCTAssertTrue(
            waitForSheet(settingsBar, dark: false),
            "Settings sheet stayed dark after switching to Auto on a light device")
    }

    @MainActor
    private func waitForSheet(
        _ element: XCUIElement, dark: Bool, timeout: TimeInterval = 5
    ) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let luminance = averageLuminance(of: element), (luminance < 0.5) == dark {
                return true
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        }
        return false
    }

    @MainActor
    private func averageLuminance(of element: XCUIElement) -> CGFloat? {
        guard element.exists, let image = element.screenshot().image.cgImage else { return nil }
        var pixel = [UInt8](repeating: 0, count: 4)
        guard
            let context = CGContext(
                data: &pixel,
                width: 1,
                height: 1,
                bitsPerComponent: 8,
                bytesPerRow: 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        context.draw(image, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        let red = CGFloat(pixel[0]) / 255
        let green = CGFloat(pixel[1]) / 255
        let blue = CGFloat(pixel[2]) / 255
        return 0.2126 * red + 0.7152 * green + 0.0722 * blue
    }
}

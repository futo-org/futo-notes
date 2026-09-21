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
        XCTAssertTrue(
            scrollToAppearancePicker(app),
            "The appearance picker never came into view in the Settings sheet")

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

    /// The License plate is the first section of Settings and is taller than a
    /// phone screen has to spare, so the appearance picker starts below the
    /// fold: scroll to it rather than assuming it is on screen. An off-screen
    /// row is not in the accessibility tree at all, which is why this waits on
    /// hittability and not on existence.
    @MainActor
    private func scrollToAppearancePicker(_ app: XCUIApplication) -> Bool {
        let dark = app.buttons["Dark"]
        for _ in 0..<8 {
            if dark.exists && dark.isHittable { return true }
            app.swipeUp()
        }
        return dark.exists && dark.isHittable
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

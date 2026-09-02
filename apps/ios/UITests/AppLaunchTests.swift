import XCTest

final class AppLaunchTests: XCTestCase {
    @MainActor
    func testShellRendersWithoutWaitingForVaultBootstrap() {
        let app = makeIsolatedApplication()
        app.launch()

        XCTAssertTrue(app.navigationBars["Notes"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testNativeFindBarOpensAboveKeyboardInAnIsolatedNote() {
        let app = makeIsolatedApplication()
        app.launch()

        // Quick capture is one tap: the compose nav button creates the note and
        // opens straight into its body, so there is no menu step to go through.
        let create = app.buttons["nav-create"]
        XCTAssertTrue(create.waitForExistence(timeout: 5))
        create.tap()

        let more = app.buttons["More"]
        XCTAssertTrue(more.waitForExistence(timeout: 5))
        more.tap()
        app.buttons["Find in note"].tap()

        let query = app.textFields["Find in note"]
        XCTAssertTrue(query.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["0"].exists)

        // A simulator with a hardware keyboard attached never presents the software
        // keyboard, and `app.keyboards.firstMatch` STILL exists there — as a hidden
        // element parked at the bottom edge of the window. Measuring against that
        // phantom frame is what produced "132.0 is not less than 24.0": the distance
        // to a keyboard that was not on screen at all. So branch on whether the
        // keyboard is really presented and assert only what each case can prove.
        // scripts/qa.mjs pins ConnectHardwareKeyboard=false on pool simulators so the
        // keyboard-avoidance branch below is the one that runs in this repo's QA.
        let window = app.windows.firstMatch
        let keyboard = app.keyboards.firstMatch
        if waitForSoftwareKeyboard(keyboard, in: window, timeout: 5) {
            // Read the frame only once it stops moving, so a sample taken mid
            // presentation animation cannot manufacture a phantom gap.
            let keyboardTop = settledKeyboardTop(keyboard)
            XCTAssertLessThanOrEqual(
                query.frame.maxY,
                keyboardTop,
                "find bar must sit entirely above the software keyboard"
            )
            XCTAssertLessThan(
                keyboardTop - query.frame.maxY,
                24,
                "find bar must be docked against the keyboard, not floating above it"
            )
        } else {
            XCTAssertLessThanOrEqual(
                query.frame.maxY,
                window.frame.maxY,
                "find bar must be fully on screen"
            )
            // 90pt covers the home-indicator inset the bar is laid out above.
            XCTAssertLessThan(
                window.frame.maxY - query.frame.maxY,
                90,
                "find bar must be docked at the bottom of the window"
            )
        }

        query.typeText("needle")
        XCTAssertTrue(app.staticTexts["0"].exists)
    }
}

/// A hidden keyboard element reports a frame parked at the bottom edge of the
/// window; a presented one overlaps the window.
@MainActor
private func softwareKeyboardIsPresented(_ keyboard: XCUIElement, in window: XCUIElement) -> Bool {
    keyboard.exists && keyboard.frame.minY < window.frame.maxY
}

@MainActor
private func waitForSoftwareKeyboard(
    _ keyboard: XCUIElement,
    in window: XCUIElement,
    timeout: TimeInterval
) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if softwareKeyboardIsPresented(keyboard, in: window) { return true }
        Thread.sleep(forTimeInterval: 0.1)
    }
    return softwareKeyboardIsPresented(keyboard, in: window)
}

/// Poll the keyboard's top edge until two consecutive samples agree, bounding the
/// wait so a keyboard that never settles fails the assertion instead of hanging.
@MainActor
private func settledKeyboardTop(_ keyboard: XCUIElement, timeout: TimeInterval = 3) -> CGFloat {
    let deadline = Date().addingTimeInterval(timeout)
    var previous = keyboard.frame.minY
    while Date() < deadline {
        Thread.sleep(forTimeInterval: 0.3)
        let current = keyboard.frame.minY
        if abs(current - previous) < 0.5 { return current }
        previous = current
    }
    return previous
}

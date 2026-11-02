import XCTest

/// One bounded physical-fixture scenario. This test is executable only through
/// Puppet's separate physical reservation and verified build/destination route.
/// It never types text, invokes callbacks, repairs services, or handles prompts.
final class DictationCaptureTests: XCTestCase {
    private struct Launch: Decodable {
        let runID: UUID
        let nonce: UUID
        let destination: String
        let seconds: Int
    }

    func testCapture() throws {
        continueAfterFailure = false
        let raw = try XCTUnwrap(ProcessInfo.processInfo.environment["FUTO_EDITOR294_LAUNCH"])
        let plan = try JSONDecoder().decode(Launch.self, from: Data(raw.utf8))
        XCTAssertNotEqual(plan.runID, plan.nonce)
        XCTAssertTrue((1...120).contains(plan.seconds))
        XCTAssertNotNil(
            plan.destination.range(of: "^[0-9A-F]{8}-[0-9A-F]{16}$", options: .regularExpression))
        let app = XCUIApplication(bundleIdentifier: "org.futo.fixture.editor294")
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        var receipt: [String: Any] = [
            "runID": plan.runID.uuidString, "nonce": plan.nonce.uuidString,
            "bundleID": "org.futo.fixture.editor294", "destination": plan.destination,
            "status": "refused-before-dictate", "action": "none",
        ]
        defer {
            let attachment = XCTAttachment(
                data: (try? JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys]))
                    ?? Data(),
                uniformTypeIdentifier: "public.json")
            attachment.name = "editor294-gesture.json"
            attachment.lifetime = .keepAlways
            add(attachment)
            // Exact fixture identity only. Evidence remains in its UUID directory.
            if app.state == .runningForeground || app.state == .runningBackground {
                app.terminate()
            }
        }
        func noPrompt() -> Bool { app.alerts.count == 0 && springboard.alerts.count == 0 }
        XCTAssertTrue(noPrompt(), "Unexpected system prompt; human intervention required")
        app.launchEnvironment = ["FUTO_EDITOR_CAPTURE_LAUNCH": raw]
        app.launchArguments = []
        app.launch()
        XCTAssertEqual(app.state, .runningForeground, "Device unavailable or locked")
        let identifier = "editor294:\(plan.runID.uuidString):\(plan.nonce.uuidString):"
        let field = app.textViews[identifier + "capturing"]
        XCTAssertTrue(
            field.waitForExistence(timeout: 15), "Fixture did not echo this run and nonce")
        XCTAssertTrue(noPrompt(), "Unexpected system prompt; no dismissal permitted")
        XCTAssertEqual(app.state, .runningForeground)
        XCTAssertTrue(field.isHittable)
        receipt["opening"] = field.value as? String
        field.tap()
        XCTAssertTrue(
            app.keyboards.firstMatch.waitForExistence(timeout: 5), "Live software keyboard absent")
        XCTAssertTrue(noPrompt(), "Unexpected system prompt; no dismissal permitted")
        let dictate = app.keyboards.buttons.matching(
            NSPredicate(format: "label IN %@", ["Dictate", "Start Dictation"]))
        XCTAssertEqual(dictate.count, 1, "Live Dictate control absent or ambiguous")
        let button = dictate.element(boundBy: 0)
        XCTAssertTrue(button.isHittable, "Live Dictate control not reachable")
        XCTAssertEqual(app.state, .runningForeground)
        let rect = button.frame
        receipt["control"] = [
            "label": button.label, "identifier": button.identifier, "hittable": button.isHittable,
            "frame": ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height],
        ]
        receipt["action"] = "tap-system-dictate"
        receipt["tapTime"] = Date().timeIntervalSince1970
        button.tap()
        receipt["status"] = "dictate-tapped"
        var unexpectedPrompt = false
        let ended = app.textViews[identifier + "capture-window-ended"]
        let completion = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in
                unexpectedPrompt = !noPrompt()
                return unexpectedPrompt || ended.exists || app.state != .runningForeground
            }, object: nil)
        XCTAssertEqual(
            XCTWaiter.wait(for: [completion], timeout: Double(plan.seconds + 10)), .completed,
            "Bounded capture timed out")
        XCTAssertFalse(unexpectedPrompt, "Unexpected system prompt; no dismissal permitted")
        XCTAssertEqual(app.state, .runningForeground, "Device locked or fixture left foreground")
        XCTAssertTrue(ended.exists, "Fixture capture did not complete")
        receipt["current"] = ended.value as? String
        receipt["status"] = "capture-window-ended"
        receipt["endTime"] = Date().timeIntervalSince1970
    }
}

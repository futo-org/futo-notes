import UIKit
import XCTest

/// A real single tap in nested list text must place a caret, so typing inserts rather than
/// replacing the whole word. This exercises UIKit's text interaction, not an engine selection.
final class TextFirstSelectionUITests: XCTestCase {
    @MainActor
    func testSingleTapsInNestedTextInsertWithoutReplacingTheWord() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("text-first-taps-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try "- What about\n  - Nested\n  - Elements\n".write(
            to: root.appendingPathComponent("taps.md"), atomically: true, encoding: .utf8)
        let app = makeIsolatedApplication()
        app.launchEnvironment["FUTO_NOTES_DATA_DIR"] = root.path
        app.launchArguments += ["-futo.textFirstEditor", "YES", "-AppleLanguages", "(en)"]
        app.launch()
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "taps"))
            .firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        row.tap()
        let editor = app.textViews["text-first-editor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 15))
        // Match the recording's input history too: erase the nested word, retype it without
        // a trailing space, then move to its sibling while autocorrection is still enabled.
        editor.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: 155, dy: 39)).tap()
        editor.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 6))
        XCTAssertFalse((editor.value as? String ?? "").contains("Nested"))
        editor.typeText("Nested")
        let before = try XCTUnwrap(editor.value as? String)
        XCTAssertTrue(before.contains("Nested") && before.contains("Elements"))
        let line = try XCTUnwrap(before.components(separatedBy: "\n").firstIndex(of: "Elements"))
        let y = 4 + CGFloat(line) * (UIFont.systemFont(ofSize: 17).lineHeight + 4) + 10
        for x in [82.0, 98.0, 119.0] {
            editor.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: x, dy: y)).tap()
            editor.typeText("Z")
            let after = try XCTUnwrap(editor.value as? String)
            XCTAssertEqual(after.replacingOccurrences(of: "Z", with: ""), before)
            XCTAssertEqual(after.count, before.count + 1)
            editor.typeText(XCUIKeyboardKey.delete.rawValue)
            XCTAssertEqual(editor.value as? String, before)
        }
        try app.screenshot().pngRepresentation.write(
            to: root.appendingPathComponent("single-taps.png"))
        print("TF_SELECTION_SHOTS \(root.path)")
    }
}

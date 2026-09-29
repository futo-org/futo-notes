import SwiftUI
import Testing
import UIKit

@testable import FutoNotesNative

/// The title field filters input before UIKit applies it, so UIKit's undo stack
/// only ever records edits that really happened. Crash 1747 (NSRangeException in
/// NSMutableRLEArray) was an undo replaying a range recorded before the field
/// rewrote its own text shorter.
@MainActor
@Suite("Inline title field input filter")
struct TitleTextFieldUndoTests {
    private final class ForbiddenFlag { var raised = false }

    private func focusedTitleField(flag: ForbiddenFlag = ForbiddenFlag()) throws -> (
        UIWindow, UITextField
    ) {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 200))
        window.rootViewController = UIHostingController(
            rootView: TitleTextField(
                text: .constant(""), placeholder: "Untitled", onChange: { _ in },
                onForbidden: { flag.raised = true })
        )
        window.makeKeyAndVisible()
        window.layoutIfNeeded()
        let field = try #require(Self.firstTextField(in: window))
        #expect(field.becomeFirstResponder())
        return (window, field)
    }

    private static func firstTextField(in view: UIView) -> UITextField? {
        if let field = view as? UITextField { return field }
        return view.subviews.lazy.compactMap(firstTextField(in:)).first
    }

    /// Delivers `text` at the caret the way the keyboard and paste do: ask the
    /// delegate first and apply the edit only if it allows it. A bare
    /// `insertText` skips the delegate entirely.
    private func userEnters(_ text: String, into field: UITextField) async throws {
        let selection = field.selectedTextRange!
        let range = NSRange(
            location: field.offset(from: field.beginningOfDocument, to: selection.start),
            length: field.offset(from: selection.start, to: selection.end))
        if field.delegate?.textField?(
            field, shouldChangeCharactersIn: range, replacementString: text) ?? true
        {
            field.insertText(text)
        }
        // Yield the main queue so a deferred replace runs and the undo group
        // closes, as the end of a real input event does.
        try await Task.sleep(for: .milliseconds(20))
    }

    @Test("a typed forbidden character never lands, and undo still reverts earlier typing")
    func typedForbiddenCharacter() async throws {
        let flag = ForbiddenFlag()
        let (window, field) = try focusedTitleField(flag: flag)
        try await userEnters("abc", into: field)
        try await userEnters("?", into: field)
        #expect(field.text == "abc")
        #expect(flag.raised)
        field.undoManager?.undo()
        #expect(field.text == "")
        _ = window
    }

    @Test("a paste with forbidden characters and newlines arrives cleaned as one undoable edit")
    func pastedForbiddenCharacters() async throws {
        let flag = ForbiddenFlag()
        let (window, field) = try focusedTitleField(flag: flag)
        try await userEnters("x", into: field)
        try await userEnters("a/b\nc", into: field)
        #expect(field.text == "xabc")
        #expect(flag.raised)
        field.undoManager?.undo()
        #expect(field.text == "x")
        _ = window
    }

    @Test("an emoji joined with U+200D is kept whole and raises no warning")
    func joinedEmojiIsKept() async throws {
        let flag = ForbiddenFlag()
        let (window, field) = try focusedTitleField(flag: flag)
        let family = "👨\u{200D}👩\u{200D}👧"
        try await userEnters(family, into: field)
        #expect(field.text == family)
        #expect(!flag.raised)
        _ = window
    }

    @Test("a paste past the length cap is trimmed to fit, and undo removes only the paste")
    func pastePastLengthCap() async throws {
        let (window, field) = try focusedTitleField()
        let nearlyFull = String(repeating: "a", count: TitleSpec.maxLength - 1)
        try await userEnters(nearlyFull, into: field)
        try await userEnters("bcd", into: field)
        #expect(field.text == nearlyFull + "b")
        field.undoManager?.undo()
        #expect(field.text == nearlyFull)
        _ = window
    }

    /// Input that bypasses the delegate (a committed IME composition) is still
    /// filtered; the rewrite clears undo instead of leaving it pointing past the end.
    @Test("input that skips the delegate is still filtered, and undo does not crash")
    func delegateBypassIsFiltered() async throws {
        let flag = ForbiddenFlag()
        let (window, field) = try focusedTitleField(flag: flag)
        field.insertText("abc?")
        #expect(field.text == "abc")
        #expect(flag.raised)
        field.undoManager?.undo()
        _ = window
    }
}

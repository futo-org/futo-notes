import SwiftUI
import Testing
import UIKit

@testable import FutoNotesNative

/// The feedback message caps its length before UIKit applies an edit, so undo
/// never replays a range past the end of the text (crash 1747's mechanism).
@MainActor
@Suite("Feedback message field length cap")
struct FeedbackMessageFieldTests {
    private static func firstTextView(in view: UIView) -> UITextView? {
        if let textView = view as? UITextView { return textView }
        return view.subviews.lazy.compactMap(firstTextView(in:)).first
    }

    /// Delivers `text` at the caret the way the keyboard and paste do: ask the
    /// delegate first and apply the edit only if it allows it.
    private func userEnters(_ text: String, into textView: UITextView) async throws {
        let range = textView.selectedRange
        if textView.delegate?.textView?(textView, shouldChangeTextIn: range, replacementText: text)
            ?? true
        {
            textView.insertText(text)
        }
        // Yield the main queue so a deferred replace runs and the undo group
        // closes, as the end of a real input event does.
        try await Task.sleep(for: .milliseconds(20))
    }

    @Test("a paste past the cap is trimmed to fit, and undo removes only the paste")
    func pastePastCap() async throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 400))
        window.rootViewController = UIHostingController(
            rootView: FeedbackMessageField(text: .constant("")))
        window.makeKeyAndVisible()
        window.layoutIfNeeded()
        let textView = try #require(Self.firstTextView(in: window))
        #expect(textView.becomeFirstResponder())

        let nearlyFull = String(repeating: "a", count: FeedbackSubmission.maxMessageLength - 1)
        try await userEnters(nearlyFull, into: textView)
        try await userEnters("bcd", into: textView)
        #expect(textView.text == nearlyFull + "b")
        textView.undoManager?.undo()
        #expect(textView.text == nearlyFull)
    }
}

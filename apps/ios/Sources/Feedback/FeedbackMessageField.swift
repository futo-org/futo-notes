import SwiftUI
import UIKit

struct FeedbackMessageField: UIViewRepresentable {
    @Binding var text: String
    @Environment(\.localization) private var localization

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.delegate = context.coordinator
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.inputAccessoryView = FutoKeyboardAccessory(
            content: KeyboardDismissAccessoryView(
                toolbarLocalization: context.coordinator.toolbarLocalization
            ) { [weak view] in
                view?.resignFirstResponder()
            })
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.text = $text
        context.coordinator.toolbarLocalization.update(localization)
        if view.text != text { view.text = text }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(text: $text, localization: localization)
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var text: Binding<String>
        let toolbarLocalization: EditorToolbarLocalization

        init(text: Binding<String>, localization: Localization) {
            self.text = text
            toolbarLocalization = EditorToolbarLocalization(localization)
        }

        /// Cap the length BEFORE UIKit applies an edit, so undo never replays a
        /// range past the end of a rewritten text (crash 1747's mechanism).
        func textView(
            _ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText: String
        ) -> Bool {
            // IME composition edits marked text; textViewDidChange caps it on commit.
            guard textView.markedTextRange == nil else { return true }
            let current = textView.text as NSString
            // Refuse rather than throw on a range past the end.
            guard NSMaxRange(range) <= current.length else { return false }
            let untouched = current.replacingCharacters(in: range, with: "")
            let room = max(0, FeedbackSubmission.maxMessageLength - untouched.count)
            guard replacementText.count > room else { return true }
            let allowed = String(replacementText.prefix(room))
            if !(allowed.isEmpty && range.length == 0) {
                textView.replaceAfterCurrentEdit(range, with: allowed)
            }
            return false
        }

        func textViewDidChange(_ textView: UITextView) {
            // Backstop for input that skipped the delegate, such as an IME
            // composition. A programmatic `text` write invalidates UIKit's undo
            // stack, so clear it rather than let undo crash.
            if textView.markedTextRange == nil,
                textView.text.count > FeedbackSubmission.maxMessageLength
            {
                textView.text = String(textView.text.prefix(FeedbackSubmission.maxMessageLength))
                textView.undoManager?.removeAllActions()
            }
            text.wrappedValue = textView.text
        }
    }
}

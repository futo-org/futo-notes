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

        func textViewDidChange(_ textView: UITextView) {
            if textView.text.count > FeedbackSubmission.maxMessageLength {
                let caret = textView.selectedRange.location
                textView.text = String(textView.text.prefix(FeedbackSubmission.maxMessageLength))
                textView.selectedRange = NSRange(
                    location: min(caret, textView.text.utf16.count), length: 0)
            }
            text.wrappedValue = textView.text
        }
    }
}

import SwiftUI
import UIKit

/// A note title that is still the auto-assigned placeholder: exactly "Untitled",
/// or a dedup variant "Untitled-N" (see the Rust store's `unique_note_id`, which
/// appends `-2`, `-3`, …). Tapping such a title selects it whole so a keystroke
/// replaces it; any other title takes the caret at the tapped character.
func isPlaceholderTitle(_ t: String) -> Bool {
    if t == "Untitled" { return true }
    guard t.hasPrefix("Untitled-") else { return false }
    let suffix = t.dropFirst("Untitled-".count)
    return !suffix.isEmpty && suffix.allSatisfy(\.isNumber)
}

/// Inline, tappable note title — the iOS counterpart of Android's title
/// `BasicTextField`. Backed by `UITextField` so the tap behavior is exact:
/// beginning to edit a placeholder title selects the whole text (a keystroke
/// replaces it), while a real title keeps UIKit's tap-positioned caret. Text
/// edits are reported via `onChange` (the editor debounces the rename).
// Not `private`: TitleTextFieldLayoutTests hosts it to measure its width, and
// `@testable import` cannot reach a private type.
struct TitleTextField: UIViewRepresentable {
    @Binding var text: String
    let placeholder: String
    var onChange: (String) -> Void
    /// A forbidden character was typed and stripped (drives the transient warning).
    var onForbidden: () -> Void = {}

    func makeUIView(context: Context) -> UITextField {
        let tf = UITextField()
        tf.delegate = context.coordinator
        tf.text = text
        tf.placeholder = placeholder
        tf.font = .systemFont(ofSize: 22, weight: .semibold)
        tf.textColor = .label
        tf.returnKeyType = .done
        tf.clearButtonMode = .never
        // Titles are proper nouns as often as sentences; don't fight the user.
        tf.autocapitalizationType = .sentences
        tf.addTarget(
            context.coordinator, action: #selector(Coordinator.editingChanged(_:)),
            for: .editingChanged)
        tf.setContentHuggingPriority(.required, for: .vertical)
        tf.setContentCompressionResistancePriority(.required, for: .vertical)
        return tf
    }

    func updateUIView(_ uiView: UITextField, context: Context) {
        context.coordinator.parent = self
        uiView.placeholder = placeholder
        // Adopt external title changes (a debounced/remote rename rewrote it)
        // WITHOUT stomping what the user is actively typing.
        if !uiView.isFirstResponder, uiView.text != text {
            uiView.text = text
        }
    }

    /// Take the offered width verbatim instead of the width the text wants
    /// (list.md). A definite proposal is a real layout slot, so the field fills
    /// it and no more. A nil/infinite proposal is SwiftUI asking for an ideal
    /// size, where the natural text width is the honest answer — returning nil
    /// defers to it.
    func sizeThatFits(
        _ proposal: ProposedViewSize, uiView: UITextField, context: Context
    ) -> CGSize? {
        guard let width = proposal.width, width.isFinite else { return nil }
        let height = uiView.systemLayoutSizeFitting(
            CGSize(width: width, height: UIView.layoutFittingCompressedSize.height),
            withHorizontalFittingPriority: .required,
            verticalFittingPriority: .fittingSizeLevel
        ).height
        return CGSize(width: width, height: height)
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: TitleTextField
        init(_ parent: TitleTextField) { self.parent = parent }

        /// Newlines removed silently; forbidden filesystem chars removed and
        /// reported (desktop parity — the illegal char never persists).
        private static func stripped(_ text: String) -> (text: String, hadForbidden: Bool) {
            let withoutNewlines = text.replacingOccurrences(of: "\n", with: "")
            let cleaned = String(
                String.UnicodeScalarView(
                    withoutNewlines.unicodeScalars.filter {
                        !TitleSpec.forbiddenScalars.contains($0)
                    }))
            return (cleaned, cleaned != withoutNewlines)
        }

        /// Filter every edit BEFORE UIKit applies it, so UIKit's undo stack only
        /// records edits that really happened. Rewriting `tf.text` after the fact
        /// left undo replaying a range past the new end — crash 1747
        /// (NSRangeException in NSMutableRLEArray).
        func textField(
            _ tf: UITextField, shouldChangeCharactersIn range: NSRange,
            replacementString string: String
        ) -> Bool {
            // IME composition edits marked text; editingChanged filters it on commit.
            guard tf.markedTextRange == nil else { return true }
            let current = (tf.text ?? "") as NSString
            // Refuse rather than throw on a range past the end.
            guard NSMaxRange(range) <= current.length else { return false }
            let (cleaned, hadForbidden) = Self.stripped(string)
            let allowed = current.longestPrefix(
                of: cleaned, replacing: range, within: TitleSpec.maxLength)
            guard allowed != string else { return true }
            if allowed.isEmpty && range.length == 0 {
                if hadForbidden { parent.onForbidden() }
            } else {
                // Warn after the replace: its editingChanged → onChange clears the warning.
                tf.replaceAfterCurrentEdit(range, with: allowed) {
                    if hadForbidden { self.parent.onForbidden() }
                }
            }
            return false
        }

        @objc func editingChanged(_ tf: UITextField) {
            let text = tf.text ?? ""
            var strippedForbidden = false
            // Backstop for input that skipped the delegate, such as an IME
            // composition. A programmatic `text` write invalidates UIKit's undo
            // stack, so clear it rather than let undo crash.
            if tf.markedTextRange == nil {
                let (cleaned, hadForbidden) = Self.stripped(text)
                let capped = String(cleaned.prefix(TitleSpec.maxLength))
                if capped != text {
                    tf.text = capped
                    tf.undoManager?.removeAllActions()
                    strippedForbidden = hadForbidden
                }
            }
            parent.text = tf.text ?? ""
            parent.onChange(tf.text ?? "")
            // After onChange, which clears the warning.
            if strippedForbidden { parent.onForbidden() }
        }

        func textFieldDidBeginEditing(_ tf: UITextField) {
            // Placeholder title → select all so a keystroke replaces it. Real
            // title → leave UIKit's tap-positioned caret alone. Async so it runs
            // AFTER UIKit places the caret from the tap (otherwise the tap wins).
            guard isPlaceholderTitle(tf.text ?? "") else { return }
            DispatchQueue.main.async { tf.selectAll(nil) }
        }

        func textFieldShouldReturn(_ tf: UITextField) -> Bool {
            tf.resignFirstResponder()
            EditorHost.shared.focusBody()
            return false
        }
    }
}

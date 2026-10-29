#if DEBUG
    import UIKit

    /// An ordinary UIKit control, deliberately separate from the editor. Overrides only
    /// observe and forward: input must come from the OS, never a puppet composition verb.
    final class NativeInputRecorder: UITextView, UITextViewDelegate {
        private(set) var events: [[String: Any]] = []
        private var stack: [Int] = []
        private var nextID = 0
        private var placeholderIDs: [ObjectIdentifier: Int] = [:]
        private var nextPlaceholderID = 0
        private var isCapturing = true

        func beginCapture() {
            events = []
            nextID = 0
            placeholderIDs = [:]
            nextPlaceholderID = 0
            isCapturing = true
            delegate = self
        }

        func endCapture() { isCapturing = false }

        func snapshot() -> [String: Any] {
            [
                "textUTF16": Array((text ?? "").utf16),
                "selected": offsets(selectedTextRange),
                "marked": offsets(markedTextRange),
                "language": textInputMode?.primaryLanguage as Any? ?? NSNull(),
                "availableLanguages": UITextInputMode.activeInputModes.compactMap(
                    \.primaryLanguage),
            ]
        }

        /// Layout is read only on request, never from an input callback.
        func selectionRectOnScreen() -> [Double] {
            guard let range = selectedTextRange else { return [] }
            let rect = convert(firstRect(for: range), to: window)
            return [rect.minX, rect.minY, rect.width, rect.height].map(Double.init)
        }

        private func offsets(_ range: UITextRange?) -> Any {
            guard let range else { return NSNull() }
            return [
                offset(from: beginningOfDocument, to: range.start),
                offset(from: beginningOfDocument, to: range.end),
            ]
        }

        private func record<T>(
            _ method: String, _ arguments: [String: Any] = [:],
            _ forward: () -> T
        ) -> T {
            guard isCapturing else { return forward() }
            nextID += 1
            let id = nextID
            let index = events.count
            events.append([
                "id": id, "parent": stack.last as Any? ?? NSNull(),
                "method": method, "arguments": arguments, "before": snapshot(),
            ])
            stack.append(id)
            let result = forward()
            stack.removeLast()
            events[index]["after"] = snapshot()
            if let value = result as? Bool { events[index]["returned"] = value }
            return result
        }

        // UIKit text services can change the backing storage without calling the public
        // replace override. Observe the ordinary delegate boundary as well. The default
        // editing decision is unchanged: this plain control accepts the proposed edit.
        func textView(
            _ textView: UITextView, shouldChangeTextIn range: NSRange,
            replacementText text: String
        ) -> Bool {
            record(
                "shouldChangeText",
                [
                    "range": [range.location, range.location + range.length],
                    "textUTF16": Array(text.utf16),
                ]
            ) { true }
        }

        func textViewDidChange(_ textView: UITextView) { record("didChange") {} }
        func textViewDidChangeSelection(_ textView: UITextView) { record("didChangeSelection") {} }

        override func setMarkedText(_ markedText: String?, selectedRange: NSRange) {
            record(
                "setMarkedText",
                [
                    "textUTF16": markedText.map { Array($0.utf16) } as Any? ?? NSNull(),
                    "relativeSelection": [selectedRange.location, selectedRange.length],
                ]
            ) {
                super.setMarkedText(markedText, selectedRange: selectedRange)
            }
        }

        override func unmarkText() { record("unmarkText") { super.unmarkText() } }
        override func insertText(_ text: String) {
            record("insertText", ["textUTF16": Array(text.utf16)]) { super.insertText(text) }
        }
        override func deleteBackward() { record("deleteBackward") { super.deleteBackward() } }
        override func replace(_ range: UITextRange, withText text: String) {
            record("replace", ["range": offsets(range), "textUTF16": Array(text.utf16)]) {
                super.replace(range, withText: text)
            }
        }
        override var selectedTextRange: UITextRange? {
            get { super.selectedTextRange }
            set {
                record("selectedTextRange", ["range": offsets(newValue)]) {
                    super.selectedTextRange = newValue
                }
            }
        }
        override var insertDictationResultPlaceholder: Any {
            guard isCapturing else { return super.insertDictationResultPlaceholder }
            let index = events.count
            let token = record("insertDictationResultPlaceholder") {
                let token = super.insertDictationResultPlaceholder
                let identity = ObjectIdentifier(token as AnyObject)
                if placeholderIDs[identity] == nil {
                    nextPlaceholderID += 1
                    placeholderIDs[identity] = nextPlaceholderID
                }
                return token
            }
            events[index]["returnedToken"] = placeholderIDs[ObjectIdentifier(token as AnyObject)]
            return token
        }
        override func dictationRecordingDidEnd() {
            record("dictationRecordingDidEnd") { super.dictationRecordingDidEnd() }
        }

        override func dictationRecognitionFailed() {
            record("dictationRecognitionFailed") { super.dictationRecognitionFailed() }
        }

        override func insertDictationResult(_ dictationResult: [UIDictationPhrase]) {
            record(
                "insertDictationResult",
                [
                    "phrases": dictationResult.map {
                        [
                            "textUTF16": Array($0.text.utf16),
                            "alternativesUTF16": $0.alternativeInterpretations.map {
                                $0.map { Array($0.utf16) }
                            } as Any? ?? NSNull(),
                        ]
                    }
                ]
            ) { super.insertDictationResult(dictationResult) }
        }

        override func frame(forDictationResultPlaceholder placeholder: Any) -> CGRect {
            guard isCapturing else {
                return super.frame(forDictationResultPlaceholder: placeholder)
            }
            let index = events.count
            let rect = record(
                "frameForDictationResultPlaceholder",
                [
                    "token": placeholderIDs[ObjectIdentifier(placeholder as AnyObject)] as Any?
                        ?? NSNull()
                ]
            ) { super.frame(forDictationResultPlaceholder: placeholder) }
            events[index]["returnedRect"] = [rect.minX, rect.minY, rect.width, rect.height].map {
                $0.isFinite ? Double($0) as Any : String(describing: $0)
            }
            return rect
        }

        override func removeDictationResultPlaceholder(_ placeholder: Any, willInsertResult: Bool) {
            record(
                "removeDictationResultPlaceholder",
                [
                    "token": placeholderIDs[ObjectIdentifier(placeholder as AnyObject)] as Any?
                        ?? NSNull(),
                    "willInsertResult": willInsertResult,
                ]
            ) {
                super.removeDictationResultPlaceholder(
                    placeholder, willInsertResult: willInsertResult)
            }
            placeholderIDs.removeValue(forKey: ObjectIdentifier(placeholder as AnyObject))
        }
    }

#endif

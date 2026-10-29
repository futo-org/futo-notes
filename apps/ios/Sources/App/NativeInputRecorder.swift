#if DEBUG
    import SwiftUI
    import UIKit

    /// An ordinary UIKit control, deliberately separate from the editor. Overrides only
    /// observe and forward: input must come from the OS, never a puppet composition verb.
    final class NativeInputRecorder: UITextView, UITextViewDelegate {
        private(set) var events: [[String: Any]] = []
        private var stack: [Int] = []
        private var nextID = 0
        private var placeholderIDs: [ObjectIdentifier: Int] = [:]

        func beginCapture() {
            events = []
            nextID = 0
            placeholderIDs = [:]
            delegate = self
        }

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
            let index = events.count
            let token = record("insertDictationResultPlaceholder") {
                let token = super.insertDictationResultPlaceholder
                placeholderIDs[ObjectIdentifier(token as AnyObject)] = placeholderIDs.count + 1
                return token
            }
            events[index]["returnedToken"] = placeholderIDs[ObjectIdentifier(token as AnyObject)]
            return token
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
        }
    }

    private struct NativeInputControl: UIViewRepresentable {
        let control: NativeInputRecorder
        func makeUIView(context: Context) -> NativeInputRecorder { control }
        func updateUIView(_ view: NativeInputRecorder, context: Context) {}
    }

    /// DEBUG-only opt-in fixture. It never attaches to a user note or writes the control
    /// contents back to the vault. Source/display are obtained through the public facade.
    struct NativeInputRecorderScope: ViewModifier {
        @State private var control: NativeInputRecorder?
        @State private var source = ""
        @State private var opening: [String: Any] = [:]

        func body(content: Content) -> some View {
            content
                .puppetVerbs {
                    [
                        PuppetVerbs.Verb("OpenNativeInputRecorder", optional: ["source"]) { args in
                            let fixture = args["source"] as? String ?? "__ab__ &amp; cd\r\n"
                            let display = try await Task.detached {
                                let root = FileManager.default.temporaryDirectory
                                    .appendingPathComponent("native-input-\(UUID().uuidString)")
                                try FileManager.default.createDirectory(
                                    at: root, withIntermediateDirectories: true)
                                defer { try? FileManager.default.removeItem(at: root) }
                                let store = NoteStore(notesRoot: root.path)
                                _ = try store.createNote(
                                    title: "fixture", folder: "", content: fixture)
                                let session = try store.openEditor(id: "fixture")
                                defer { try? session.detach() }
                                return try session.displayText()
                            }.value
                            let view = NativeInputRecorder()
                            view.font = .systemFont(ofSize: 22)
                            view.autocorrectionType = .yes
                            view.autocapitalizationType = .sentences
                            view.spellCheckingType = .no
                            view.accessibilityIdentifier = "native-input-recorder"
                            view.text = display
                            view.beginCapture()
                            source = fixture
                            opening = view.snapshot()
                            control = view
                            return ["opening": opening, "sourceUTF16": Array(fixture.utf16)]
                        }
                    ]
                }
                .fullScreenCover(
                    isPresented: Binding(get: { control != nil }, set: { if !$0 { control = nil } })
                ) {
                    if let control {
                        NativeInputControl(control: control)
                            .puppetVerbs(modal: true) {
                                [
                                    PuppetVerbs.Verb("ReadNativeInputRecorder") { _ in
                                        [
                                            "formatVersion": 1, "sourceUTF16": Array(source.utf16),
                                            "opening": opening, "current": control.snapshot(),
                                            "events": control.events,
                                            "os": ProcessInfo.processInfo
                                                .operatingSystemVersionString,
                                            "traits": [
                                                "autocorrection": control.autocorrectionType
                                                    .rawValue,
                                                "autocapitalization": control.autocapitalizationType
                                                    .rawValue,
                                                "spellChecking": control.spellCheckingType.rawValue,
                                                "keyboard": control.keyboardType.rawValue,
                                            ],
                                        ]
                                    },
                                    PuppetVerbs.Verb(
                                        "SelectNativeInputRecorder", required: ["start", "end"],
                                        integers: ["start", "end"]
                                    ) { args in
                                        let start = (args["start"] as? NSNumber)?.intValue ?? -1
                                        let end = (args["end"] as? NSNumber)?.intValue ?? -1
                                        guard start >= 0, end >= start,
                                            end <= (control.text as NSString).length
                                        else {
                                            throw PuppetVerbRefusal(400, "invalid UTF16 selection")
                                        }
                                        control.selectedRange = NSRange(
                                            location: start, length: end - start)
                                        return ["current": control.snapshot()]
                                    },
                                    PuppetVerbs.Verb("CloseNativeInputRecorder") { _ in
                                        self.control = nil
                                        return [:]
                                    },
                                ]
                            }
                    }
                }
        }
    }
#endif

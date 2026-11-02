#if DEBUG
    import SwiftUI
    import UIKit

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
                                            "selectionRect": control.selectionRectOnScreen(),
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

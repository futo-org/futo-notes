import Foundation
import Testing
import UIKit

@testable import Editor294Fixture

@Suite("Isolated UIKit fixture (synthetic unit calls, never OS evidence)")
@MainActor
struct FixtureCaptureTests {
    @Test("plain observed control forwards insertion and records exact UTF16 nesting")
    func forwarding() throws {
        let view = NativeInputRecorder()
        for selector in [
            #selector(UITextInput.dictationRecordingDidEnd),
            #selector(UITextInput.dictationRecognitionFailed),
            #selector(UITextInput.insertDictationResult(_:)),
            #selector(getter: UITextInput.insertDictationResultPlaceholder),
            #selector(UITextInput.frame(forDictationResultPlaceholder:)),
            #selector(UITextInput.removeDictationResultPlaceholder(_:willInsertResult:)),
        ] {
            #expect(view.responds(to: selector) == UITextView.instancesRespond(to: selector))
        }
        view.text = "a😀\r\n"
        view.selectedRange = NSRange(location: 3, length: 0)
        view.beginCapture()
        view.insertText("日本")
        #expect(view.text == "a😀日本\r\n")
        let event = try #require(view.events.first { $0["method"] as? String == "insertText" })
        #expect(
            (event["arguments"] as? [String: Any])?["textUTF16"] as? [UInt16] == [0x65E5, 0x672C])
        #expect(
            (event["after"] as? [String: Any])?["textUTF16"] as? [UInt16] == [
                97, 0xD83D, 0xDE00, 0x65E5, 0x672C, 13, 10,
            ])
        let ids = Set(view.events.compactMap { $0["id"] as? Int })
        for callback in view.events {
            if let parent = callback["parent"] as? Int { #expect(ids.contains(parent)) }
        }
        view.dictationRecordingDidEnd()
        view.dictationRecognitionFailed()
        view.insertDictationResult([])
        #expect(view.events.contains { $0["method"] as? String == "dictationRecordingDidEnd" })
        #expect(view.events.contains { $0["method"] as? String == "dictationRecognitionFailed" })
        let result = try #require(
            view.events.first { $0["method"] as? String == "insertDictationResult" })
        let phrases = try #require(
            (result["arguments"] as? [String: Any])?["phrases"] as? [[String: Any]])
        #expect(phrases.isEmpty)
        #expect(view.text == "a😀日本\r\n")
        #expect(view.selectedRange == NSRange(location: 5, length: 0))
    }

    @Test("public store projection uses only the fixture UUID vault")
    func projection() async throws {
        let launch = CaptureLaunch(
            runID: UUID(), nonce: UUID(), destination: "synthetic-unit-test", seconds: 1)
        let workspace = try CaptureWorkspace(launch: launch)
        defer { try? FileManager.default.removeItem(at: workspace.root) }
        #expect(
            workspace.artifactRelativePath
                == "tmp/editor294-\(launch.runID.uuidString)/capture.json")
        let projection = try await FixtureProjection.open(workspace: workspace)
        #expect(projection.source == "__ab__ &amp; cd\r\n")
        #expect(projection.display == "ab & cd\r\n")
        #expect(
            try String(
                contentsOf: workspace.vault.appendingPathComponent("fixture.md"), encoding: .utf8)
                == projection.source)
        // Export actual current recorder/writer bytes for the host's public
        // capture/read compatibility control. All calls here are synthetic;
        // neither this artifact nor the Node replay establishes OS dictation.
        let view = NativeInputRecorder()
        view.text = projection.display
        view.selectedRange = NSRange(location: projection.display.utf16.count, length: 0)
        view.beginCapture()
        let opening = view.snapshot()
        view.insertText("!")
        let token = view.insertDictationResultPlaceholder
        _ = view.frame(forDictationResultPlaceholder: token)
        view.removeDictationResultPlaceholder(token, willInsertResult: false)
        view.endCapture()
        let stamp: (String) -> [String: Any] = { event in
            [
                "event": event, "uptime": ProcessInfo.processInfo.systemUptime,
                "time": ISO8601DateFormatter().string(from: Date()),
            ]
        }
        try workspace.write(
            provenance: ["synthetic": true], source: projection.source, opening: opening,
            current: view.snapshot(), events: view.events,
            lifecycle: [stamp("ready"), stamp("capture-window-ended")],
            traits: [
                "autocorrection": view.autocorrectionType.rawValue,
                "autocapitalization": view.autocapitalizationType.rawValue,
                "spellChecking": view.spellCheckingType.rawValue,
                "keyboard": view.keyboardType.rawValue, "deviceModel": UIDevice.current.model,
                "systemName": UIDevice.current.systemName,
                "systemVersion": UIDevice.current.systemVersion,
            ], status: "capture-window-ended")
        print(
            "Editor294SyntheticRecorderArtifact:"
                + (try Data(contentsOf: workspace.artifact)).base64EncodedString())
    }
}

extension FixtureCaptureTests {
    @Test("only UIKit-returned opaque placeholder identity is observed unchanged")
    func opaqueIdentity() throws {
        let view = NativeInputRecorder()
        view.text = "ab"
        view.selectedRange = NSRange(location: 1, length: 0)
        view.beginCapture()
        let token = view.insertDictationResultPlaceholder
        _ = view.frame(forDictationResultPlaceholder: token)
        view.removeDictationResultPlaceholder(token, willInsertResult: false)
        let inserted = try #require(
            view.events.first { $0["method"] as? String == "insertDictationResultPlaceholder" })
        let identity = try #require(inserted["returnedToken"] as? Int)
        for method in ["frameForDictationResultPlaceholder", "removeDictationResultPlaceholder"] {
            let event = try #require(view.events.first { $0["method"] as? String == method })
            #expect((event["arguments"] as? [String: Any])?["token"] as? Int == identity)
        }
        let count = view.events.count
        view.endCapture()
        view.insertText("x")
        #expect(view.events.count == count)
        #expect(view.text.contains("x"))
    }
}

#if FUTO_DEBUG_BUILD
    import CryptoKit
    import Darwin
    import UIKit

    /// Debug-only steady typist for the kill loop (UITests/TextFirstKillLoopTests.swift), started by
    /// `FUTO_TF_STEADY_LOG=<path>`: one digit every 100 ms at the note's end through the keyboard's
    /// own UITextInput path (the delegate is asked, then UIKit inserts). The log's first line is
    /// `pid <n>` (the runner SIGKILLs that pid and nothing else); each later line is
    /// `<keys typed> <sha256 of the engine's source>`, flushed to disk before the next key.
    @MainActor
    final class TextFirstSteadyTyper {
        private let controller: TextFirstEditorController
        private let log: FileHandle
        private var timer: Timer?
        private var typed = 0

        init?(controller: TextFirstEditorController, path: String) {
            FileManager.default.createFile(atPath: path, contents: nil)
            guard let handle = FileHandle(forWritingAtPath: path) else { return nil }
            self.controller = controller
            log = handle
        }

        func start() {
            append("pid \(getpid())\n")
            let tv = controller.textView
            _ = tv.becomeFirstResponder()
            tv.selectedRange = NSRange(location: tv.textStorage.length, length: 0)
            timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.tick() }
            }
        }

        private func tick() {
            let tv = controller.textView
            let key = String(typed % 10)
            if tv.delegate?.textView?(tv, shouldChangeTextIn: tv.selectedRange, replacementText: key) ?? true {
                tv.insertText(key)
            }
            typed += 1
            let source = (try? controller.session.sourceText()) ?? ""
            let sha = SHA256.hash(data: Data(source.utf8)).map { String(format: "%02x", $0) }.joined()
            append("\(typed) \(sha)\n")
        }

        private func append(_ line: String) {
            log.write(Data(line.utf8))
            try? log.synchronize()
        }
    }
#endif

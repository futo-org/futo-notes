#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// The 20k-line smoke: open time and keystroke latency on a large note. It records numbers
    /// (printed as `TFSMOKE20K ...`) and only gates absurd regressions; the figures are not a budget.
    ///
    /// Opt-in (it only means something on the optimized engine):
    /// `TEST_RUNNER_TEXT_FIRST_SMOKE_OUT=/tmp/smoke.txt FUTO_IOS_FFI_PROFILE=release-ffi just test-ios-native TextFirstSmokeTests`.
    ///
    /// Method: the note is 20,000 lines of mixed prose and Markdown (~1 MB), made in a fresh vault.
    /// It has no ordered lists on purpose: see the ledger, the engine takes seconds per keystroke
    /// in a note with thousands of them.
    /// `open` is the Rust `openEditor` plus the controller's first display (engine parse, display
    /// text, storage). `layout` is the view's first full layout pass in a 390x700 window.
    /// A keystroke is the delegate round trip a keyboard makes (shouldChangeText, insertText, the
    /// engine's change, the view repainted) plus a layout pass, timed with CACurrentMediaTime,
    /// 300 characters typed in the middle of the note. Simulator, Debug app, release-ffi Rust.
    @Suite @MainActor
    struct TextFirstSmokeTests {
        static func largeNote(lines: Int) -> String {
            (0..<lines).map { i -> String in
                switch i % 8 {
                case 0: return "## Section \(i)"
                case 1: return "The **quick** brown fox jumps over the lazy dog, line \(i)."
                case 2: return "- item \(i) with `code` and a [link](https://example.com/\(i))"
                case 3:
                    return
                        "Plain sentence number \(i), with some words to wrap across the width of a phone."
                case 4: return "> a quoted thought \(i)"
                case 5: return "Another sentence \(i) with a trailing *emphasis* word."
                case 6: return "日本語の文章 \(i) mixed with ascii and emoji 😀"
                default: return ""
                }
            }.joined(separator: "\n") + "\n"
        }

        @Test(.enabled(if: ProcessInfo.processInfo.environment["TEXT_FIRST_SMOKE_OUT"] != nil))
        func twentyThousandLines() async throws {
            let source = Self.largeNote(lines: 20_000)
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(
                "text-first-smoke-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let store = NoteStore(notesRoot: root.path)
            _ = try store.createNote(title: "big", folder: "", content: source)

            let t0 = CACurrentMediaTime()
            let session = try store.openEditor(id: "big")
            let controller = try TextFirstEditorController(noteId: "big", session: session)
            let opened = CACurrentMediaTime()
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 700))
            let tv = controller.textView
            tv.frame = window.bounds
            window.addSubview(tv)
            window.isHidden = false
            _ = tv.becomeFirstResponder()
            tv.layoutIfNeeded()
            let laidOut = CACurrentMediaTime()

            // Caret in the middle of the note (line 10,000).
            let text = tv.text as NSString
            var offset = 0
            for _ in 0..<10_000 {
                offset =
                    text.range(
                        of: "\n", range: NSRange(location: offset, length: text.length - offset)
                    ).upperBound
            }
            tv.selectedRange = NSRange(location: offset, length: 0)
            tv.scrollRangeToVisible(tv.selectedRange)
            tv.layoutIfNeeded()

            var samples: [Double] = []
            for character in String(repeating: "abcdefghij", count: 30) {
                let s = String(character)
                let begin = CACurrentMediaTime()
                if tv.delegate?.textView?(
                    tv, shouldChangeTextIn: tv.selectedRange, replacementText: s) ?? true
                {
                    tv.insertText(s)
                }
                tv.layoutIfNeeded()
                samples.append((CACurrentMediaTime() - begin) * 1000)
            }
            samples.sort()
            func p(_ q: Double) -> Double {
                samples[min(samples.count - 1, Int(Double(samples.count) * q))]
            }
            let line =
                "TFSMOKE20K lines=20000 bytes=\(source.utf8.count) open_ms=\(Int((opened - t0) * 1000)) "
                + "first_layout_ms=\(Int((laidOut - opened) * 1000)) keys=\(samples.count) "
                + String(
                    format: "p50_ms=%.1f p95_ms=%.1f max_ms=%.1f", p(0.5), p(0.95),
                    samples.last ?? 0)
            print(line)
            if let dir = ProcessInfo.processInfo.environment["TEXT_FIRST_SMOKE_OUT"] {
                try? line.write(toFile: dir, atomically: true, encoding: .utf8)
            }
            #expect(tv.text.count > 100_000)
            _ = await controller.close()
            #expect(p(0.95) < 500, "a keystroke should not take half a second")
        }
    }
#endif

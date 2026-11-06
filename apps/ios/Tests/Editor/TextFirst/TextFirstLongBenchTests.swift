#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// Long-note timings (M8). Opt-in; prints `TFBENCH key=value ...` lines and appends them to
    /// `$TEXT_FIRST_BENCH_OUT`. Not a gate beyond absurd regressions.
    ///
    /// `TEXT_FIRST_BENCH_FILE=<note.md> TEXT_FIRST_BENCH_OUT=<log> FUTO_IOS_FFI_PROFILE=release-ffi
    /// just test-ios-native TextFirstLongBenchTests`
    ///
    /// Method: iOS 27 simulator, Debug app, release-ffi Rust, a 390x700 window. open = the Rust
    /// open plus the controller's first display and a layout pass (first text); editable = the
    /// controller holds the engine session. Keys are the delegate round trip a keyboard makes plus
    /// a layout pass, 100 characters at the top (line ~50) and at the bottom (50 lines from the
    /// end). Select All + Bold is the engine call and the repaint that follows. Rotation resizes
    /// the window to 844x390 (and back) and lays out.
    @Suite @MainActor
    struct TextFirstLongBenchTests {
        nonisolated static var file: String? {
            ProcessInfo.processInfo.environment["TEXT_FIRST_BENCH_FILE"]
        }
        static func log(_ line: String) {
            print(line)
            guard let out = ProcessInfo.processInfo.environment["TEXT_FIRST_BENCH_OUT"] else {
                return
            }
            if let handle = FileHandle(forWritingAtPath: out) {
                handle.seekToEndOfFile()
                handle.write(Data((line + "\n").utf8))
                try? handle.close()
            } else {
                try? (line + "\n").write(toFile: out, atomically: true, encoding: .utf8)
            }
        }

        static func ms(_ a: Double, _ b: Double) -> Int { Int((b - a) * 1000) }

        /// The longest the main thread was held while `body` ran and for `settle` seconds after.
        static func stall(settle: Double, _ body: () -> Void) async throws -> Int {
            var last = CACurrentMediaTime()
            var worst = 0.0
            let ticker = Timer(timeInterval: 0.004, repeats: true) { _ in
                let now = CACurrentMediaTime()
                worst = max(worst, now - last)
                last = now
            }
            RunLoop.main.add(ticker, forMode: .common)
            body()
            let began = CACurrentMediaTime()
            while CACurrentMediaTime() - began < settle {
                try await Task.sleep(nanoseconds: 5_000_000)
            }
            worst = max(worst, CACurrentMediaTime() - last)
            ticker.invalidate()
            return Int(worst * 1000)
        }

        func keys(_ tv: TextFirstTextView, count: Int) -> (p50: Double, p95: Double, max: Double) {
            var samples: [Double] = []
            for character in String(repeating: "abcdefghij", count: count / 10) {
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
            return (
                samples[samples.count / 2], samples[Int(Double(samples.count) * 0.95)],
                samples.last ?? 0
            )
        }

        func caret(at line: Int, from end: Bool, in tv: UITextView) {
            let text = tv.text as NSString
            var offset = end ? text.length : 0
            for _ in 0..<line {
                if end {
                    let r = text.range(
                        of: "\n", options: .backwards,
                        range: NSRange(location: 0, length: max(0, offset - 1)))
                    offset = r.location == NSNotFound ? 0 : r.location
                } else {
                    offset =
                        text.range(
                            of: "\n", range: NSRange(location: offset, length: text.length - offset)
                        ).upperBound
                }
            }
            tv.selectedRange = NSRange(
                location: min(offset + (end ? 1 : 0), text.length), length: 0)
            tv.scrollRangeToVisible(tv.selectedRange)
            tv.layoutIfNeeded()
        }

        @Test(.enabled(if: TextFirstLongBenchTests.file != nil))
        func longNoteTimings() async throws {
            let path = try #require(Self.file)
            let source = try String(contentsOfFile: path, encoding: .utf8)
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(
                "text-first-bench-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let store = NoteStore(notesRoot: root.path)
            _ = try store.createNote(title: "big", folder: "", content: source)
            let name = URL(fileURLWithPath: path).lastPathComponent

            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 700))
            window.isHidden = false
            let t0 = CACurrentMediaTime()
            let controller: TextFirstEditorController
            let firstText: Double
            if let quick = store.quickOpenView(id: "big") {
                // The quick first screens, then the engine's open (which runs beside them in the app).
                controller = try TextFirstEditorController(noteId: "big", quick: quick)
                let tv = controller.textView
                tv.frame = window.bounds
                window.addSubview(tv)
                tv.layoutIfNeeded()
                firstText = CACurrentMediaTime()
                try controller.attach(session: try store.openEditor(id: "big"))
            } else {
                controller = try TextFirstEditorController(
                    noteId: "big", session: try store.openEditor(id: "big"))
                let tv = controller.textView
                tv.frame = window.bounds
                window.addSubview(tv)
                tv.layoutIfNeeded()
                firstText = CACurrentMediaTime()
            }
            let tv = controller.textView
            // The text view lives in the app's container, which handles a new width.
            let container = TextFirstEditorContainer(textView: tv)
            container.frame = window.bounds
            window.addSubview(container)
            container.layoutIfNeeded()
            let editable = CACurrentMediaTime()
            tv.layoutIfNeeded()
            let styled = await TextFirstHarness.waitStyled(controller, seconds: 120)
            let styledAt = CACurrentMediaTime()

            caret(at: 50, from: false, in: tv)
            let top = keys(tv, count: 100)
            caret(at: 50, from: true, in: tv)
            let bottom = keys(tv, count: 100)

            let rotateStall = try await Self.stall(settle: 0.5) {
                container.frame = CGRect(x: 0, y: 0, width: 844, height: 390)
                container.layoutIfNeeded()
                tv.layoutIfNeeded()
            }
            let backStall = try await Self.stall(settle: 0.5) {
                container.frame = window.bounds
                container.layoutIfNeeded()
                tv.layoutIfNeeded()
            }

            tv.selectedRange = NSRange(location: 0, length: 0)
            try await Task.sleep(nanoseconds: 500_000_000)
            if let pause = ProcessInfo.processInfo.environment["TEXT_FIRST_BENCH_PAUSE"].flatMap(
                Double.init)
            {
                try await Task.sleep(nanoseconds: UInt64(pause * 1e9))
            }
            let s0 = CACurrentMediaTime()
            tv.selectAll(nil)
            let s1 = CACurrentMediaTime()
            // The longest the main thread was held while Bold ran and its styles landed.
            var lastTick = CACurrentMediaTime()
            var worst = 0.0
            var stalls: [String] = []
            let origin = CACurrentMediaTime()
            let ticker = Timer(timeInterval: 0.004, repeats: true) { _ in
                let now = CACurrentMediaTime()
                if now - lastTick > 0.25 {
                    stalls.append(
                        "\(Int((lastTick - origin) * 1000))+\(Int((now - lastTick) * 1000))")
                }
                worst = max(worst, now - lastTick)
                lastTick = now
            }
            RunLoop.main.add(ticker, forMode: .common)
            controller.format(.bold)
            let s2 = CACurrentMediaTime()
            while controller.commandRunning && CACurrentMediaTime() - s2 < 120 {
                try await Task.sleep(nanoseconds: 5_000_000)
            }
            let s3 = CACurrentMediaTime()
            tv.layoutIfNeeded()
            _ = await TextFirstHarness.waitStyled(controller, seconds: 120)
            let s4 = CACurrentMediaTime()
            ticker.invalidate()

            Self.log(
                "TFBENCH note=\(name) bytes=\(source.utf8.count) styled=\(styled) "
                    + "first_text_ms=\(Self.ms(t0, firstText)) editable_ms=\(Self.ms(t0, editable)) "
                    + "fully_styled_ms=\(Self.ms(t0, styledAt)) "
                    + String(
                        format:
                            "key_top_p50=%.1f key_top_p95=%.1f key_top_max=%.1f key_bottom_p50=%.1f key_bottom_p95=%.1f key_bottom_max=%.1f ",
                        top.p50, top.p95, top.max, bottom.p50, bottom.p95, bottom.max)
                    + "rotate_main_stall_ms=\(rotateStall) rotate_back_main_stall_ms=\(backStall) "
                    + "selectall_ms=\(Self.ms(s0, s1)) bold_call_ms=\(Self.ms(s1, s2)) bold_applied_ms=\(Self.ms(s1, s3)) "
                    + "bold_restyled_ms=\(Self.ms(s1, s4)) bold_main_stall_max_ms=\(Int(worst * 1000)) stalls_at_plus_ms=[\(stalls.joined(separator: ","))] "
                    + "phases_ms(applied=\(Self.ms(origin, s3)),layout=\(Self.ms(s3, CACurrentMediaTime())))"
            )
            _ = await controller.close()
        }

        /// Where the open's time goes (debugging the numbers above; not a gate).
        @Test(.enabled(if: TextFirstLongBenchTests.file != nil))
        func openParts() async throws {
            let path = try #require(Self.file)
            let source = try String(contentsOfFile: path, encoding: .utf8)
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(
                "text-first-parts-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let store = NoteStore(notesRoot: root.path)
            _ = try store.createNote(title: "big", folder: "", content: source)
            let t0 = CACurrentMediaTime()
            let quick = store.quickOpenView(id: "big")
            let t1 = CACurrentMediaTime()
            let session = try store.openEditor(id: "big")
            let t2 = CACurrentMediaTime()
            let display = try session.displayText()
            let t3 = CACurrentMediaTime()
            let mirror = EditorDisplayMirror(display: display)
            let t4 = CACurrentMediaTime()
            let tv = TextFirstTextView(usingTextLayoutManager: true)
            let content = tv.textLayoutManager!.textContentManager as! NSTextContentStorage
            let storage = content.textStorage!
            let attrs = TextFirstEditorController.baseAttributes
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 700))
            tv.frame = window.bounds
            window.addSubview(tv)
            window.isHidden = false
            let head = String(display.prefix(6_000))
            storage.setAttributedString(NSAttributedString(string: head, attributes: attrs))
            tv.layoutIfNeeded()
            let t5 = CACurrentMediaTime()
            let tail = String(display.dropFirst(6_000))
            let t6 = CACurrentMediaTime()
            storage.append(NSAttributedString(string: tail, attributes: attrs))
            let t7 = CACurrentMediaTime()
            tv.layoutIfNeeded()
            let t8 = CACurrentMediaTime()
            Self.log(
                "TFPARTS note=\(URL(fileURLWithPath: path).lastPathComponent) quick=\(quick == nil ? "nil" : "\(quick!.display.utf16.count)u") "
                    + "quick_ms=\(Self.ms(t0, t1)) open_editor_ms=\(Self.ms(t1, t2)) display_text_ms=\(Self.ms(t2, t3)) "
                    + "mirror_ms=\(Self.ms(t3, t4)) first6k_set_layout_ms=\(Self.ms(t4, t5)) tail_substring_ms=\(Self.ms(t6, t6 == t6 ? t6 : t6)) "
                    + "append_rest_ms=\(Self.ms(t6, t7)) layout_after_append_ms=\(Self.ms(t7, t8)) mirrorLen=\(mirror.utf16Len())"
            )
            _ = try? session.detach()
        }
    }

    extension TextFirstHarness {
        static func waitStyled(_ c: TextFirstEditorController, seconds: Double) async -> Bool {
            let deadline = Date().addingTimeInterval(seconds)
            while c.styledThrough < c.mirrorLength && Date() < deadline {
                try? await Task.sleep(nanoseconds: 20_000_000)
            }
            return c.styledThrough >= c.mirrorLength
        }
    }
#endif

#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// Does a background save block a main-thread input or query call? Recorded, not a gate.
    ///
    /// The Store's save runs on the controller's I/O queue and holds, through its filesystem work,
    /// the store gate, the vault guard and the attachment lock, all behind the FFI session's one
    /// mutex; typing and queries run on the main actor and take that same mutex. This puts a long
    /// note in a window and times, from the main thread, a session query, a keystroke and a toolbar
    /// command while the save is in flight, with the write made slow and with the store gate held by
    /// another workflow.
    ///
    /// The slow write needs a LOCAL-ONLY, never committed, sleep in
    /// `crates/futo-notes-core/src/files/vault_fs/unix.rs` `write_temp_and_install`, before
    /// `write_all`: `if let Some(ms) = std::env::var("FUTO_SLOW_WRITE_MS").ok().and_then(|v|
    /// v.parse::<u64>().ok()) { std::thread::sleep(std::time::Duration::from_millis(ms)); }`.
    /// Without it the slow levels measure the real write only.
    ///
    /// Opt-in: `TEST_RUNNER_TEXT_FIRST_CONTENTION_OUT=/tmp/contention.txt
    /// FUTO_IOS_FFI_PROFILE=release-ffi just test-ios-native TextFirstSaveContentionTests`.
    /// Numbers: docs/plan/ios-text-first.md (architecture review follow-up).
    @Suite(.serialized) @MainActor
    struct TextFirstSaveContentionTests {
        private static let out = ProcessInfo.processInfo.environment["TEXT_FIRST_CONTENTION_OUT"]

        private func ms(_ block: () -> Void) -> Double {
            let t0 = CACurrentMediaTime()
            block()
            return (CACurrentMediaTime() - t0) * 1000
        }

        private func record(_ line: String) {
            print(line)
            guard let path = Self.out else { return }
            let data = Data((line + "\n").utf8)
            if let handle = FileHandle(forWritingAtPath: path) {
                handle.seekToEndOfFile()
                handle.write(data)
                try? handle.close()
            } else {
                try? data.write(to: URL(fileURLWithPath: path))
            }
        }

        private func median(_ values: [Double]) -> Double {
            values.sorted()[values.count / 2]
        }

        @Test(.enabled(if: ProcessInfo.processInfo.environment["TEXT_FIRST_CONTENTION_OUT"] != nil))
        func aSaveInFlightAgainstInputAndQueries() async throws {
            let source = TextFirstSmokeTests.largeNote(lines: 20_000)
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(
                "text-first-contention-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let store = NoteStore(notesRoot: root.path)
            _ = try store.createNote(title: "big", folder: "", content: source)
            let controller = try TextFirstEditorController(
                noteId: "big", session: try store.openEditor(id: "big"), imageRoot: root)
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 700))
            let tv = controller.textView
            tv.frame = window.bounds
            window.addSubview(tv)
            window.isHidden = false
            tv.layoutIfNeeded()
            _ = tv.becomeFirstResponder()
            let session = controller.session
            let middle = (tv.text ?? "").utf16.count / 2
            tv.selectedRange = NSRange(location: middle, length: 0)

            func key(_ s: String) {
                if tv.delegate?.textView?(
                    tv, shouldChangeTextIn: tv.selectedRange, replacementText: s)
                    ?? true
                {
                    tv.insertText(s)
                }
            }

            // Baseline: no save in flight.
            let idleKey = (0..<60).map { _ in ms { key("a") } }
            let idleQuery = (0..<60).map { _ in ms { _ = try? session.revision() } }
            let idleDelay = (0..<60).map { _ in ms { _ = try? session.saveDelay() } }
            record(
                "TFCONTENTION idle note=\(source.utf8.count)B keyP50=\(String(format: "%.2f", median(idleKey)))ms"
                    + " revisionP50=\(String(format: "%.3f", median(idleQuery)))ms"
                    + " saveDelayP50=\(String(format: "%.3f", median(idleDelay)))ms")

            // Each level twice: the first save of a note also pays for the first diff.
            for slow in [0, 0, 200, 200, 600, 1500] {
                setenv("FUTO_SLOW_WRITE_MS", String(slow), 1)
                key("b")  // a dirty draft
                // Let the restyle slices the keystroke queued on the main queue finish first.
                try await Task.sleep(nanoseconds: 400_000_000)
                var saveDone = false
                let saveStart = CACurrentMediaTime()
                controller.checkpoint { saveDone = true }
                // Blocking the main thread (not yielding it) until the I/O queue holds the locks,
                // so no queued main-queue work can run in between.
                Thread.sleep(forTimeInterval: slow == 0 ? 0.002 : 0.05)
                let inFlight = !saveDone
                func at() -> String {
                    String(format: "%.0f", (CACurrentMediaTime() - saveStart) * 1000)
                }
                let queryAt = at()
                let queryMs = ms { _ = try? session.revision() }
                let keyAt = at()
                let keyMs = ms { key("c") }
                let delayAt = at()
                let delayMs = ms { _ = try? session.saveDelay() }
                while !saveDone { try await Task.sleep(nanoseconds: 5_000_000) }
                let saveMs = (CACurrentMediaTime() - saveStart) * 1000
                record(
                    "TFCONTENTION save slowWrite=\(slow)ms saveTotal=\(String(format: "%.0f", saveMs))ms"
                        + " inFlightAtFirstProbe=\(inFlight)"
                        + " | revision() at +\(queryAt)ms took \(String(format: "%.1f", queryMs))ms"
                        + " | keystroke at +\(keyAt)ms took \(String(format: "%.1f", keyMs))ms"
                        + " | saveDelay() at +\(delayAt)ms took \(String(format: "%.1f", delayMs))ms"
                )
                try await Task.sleep(nanoseconds: 300_000_000)
            }
            unsetenv("FUTO_SLOW_WRITE_MS")
            _ = await controller.close()
        }

        /// Another workflow holds the store gate (a sync cycle adopting a big note): the editor's
        /// save queues behind it holding the session mutex, and input waits behind the save.
        @Test(.enabled(if: ProcessInfo.processInfo.environment["TEXT_FIRST_CONTENTION_OUT"] != nil))
        func aSaveQueuedBehindAnotherWorkflowsGate() async throws {
            let source = TextFirstSmokeTests.largeNote(lines: 20_000)
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(
                "text-first-contention-gate-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let store = NoteStore(notesRoot: root.path)
            _ = try store.createNote(title: "big", folder: "", content: source)
            _ = try store.createNote(title: "other", folder: "", content: "x")
            let controller = try TextFirstEditorController(
                noteId: "big", session: try store.openEditor(id: "big"), imageRoot: root)
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 700))
            let tv = controller.textView
            tv.frame = window.bounds
            window.addSubview(tv)
            window.isHidden = false
            _ = tv.becomeFirstResponder()
            tv.selectedRange = NSRange(location: 100, length: 0)
            let session = controller.session
            // A 96 MB note written through the store's gate on another thread.
            let huge = String(
                repeating: "lorem ipsum dolor sit amet, consectetur adipiscing\n", count: 1_900_000)
            // A dirty draft first; let the keystroke's queued main-queue work finish.
            if tv.delegate?.textView?(
                tv, shouldChangeTextIn: tv.selectedRange, replacementText: "z") ?? true
            {
                tv.insertText("z")
            }
            try await Task.sleep(nanoseconds: 300_000_000)
            let gateHolder = Task.detached {
                let t0 = CACurrentMediaTime()
                _ = try? store.write(id: "other", content: huge)
                return (CACurrentMediaTime() - t0) * 1000
            }
            // The big write takes the gate; then a draft's save queues behind it.
            Thread.sleep(forTimeInterval: 0.03)
            var saveDone = false
            let saveStart = CACurrentMediaTime()
            controller.checkpoint { saveDone = true }
            Thread.sleep(forTimeInterval: 0.02)
            let queryMs = ms { _ = try? session.revision() }
            let keyMs = ms {
                if tv.delegate?.textView?(
                    tv, shouldChangeTextIn: tv.selectedRange, replacementText: "y") ?? true
                {
                    tv.insertText("y")
                }
            }
            while !saveDone { try await Task.sleep(nanoseconds: 5_000_000) }
            let saveMs = (CACurrentMediaTime() - saveStart) * 1000
            let holderMs = await gateHolder.value
            record(
                "TFCONTENTION gate otherWorkflowWrite=\(String(format: "%.0f", holderMs))ms (\(huge.utf8.count / 1_000_000)MB)"
                    + " saveTotal=\(String(format: "%.0f", saveMs))ms revisionCall=\(String(format: "%.1f", queryMs))ms"
                    + " keystroke=\(String(format: "%.1f", keyMs))ms")
            _ = await controller.close()
        }

        /// M8 runs large engine jobs on the controller's I/O queue (the same serial queue as saves)
        /// and drops keys and taps while one runs. A job asked for during a slow save queues behind
        /// it: the main thread stays free, and input is dropped for as long as the save lasts.
        @Test(.enabled(if: ProcessInfo.processInfo.environment["TEXT_FIRST_CONTENTION_OUT"] != nil))
        func aHeavyCommandQueuedBehindASlowSave() async throws {
            let source = TextFirstSmokeTests.largeNote(lines: 20_000)
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(
                "text-first-contention-job-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let store = NoteStore(notesRoot: root.path)
            _ = try store.createNote(title: "big", folder: "", content: source)
            let controller = try TextFirstEditorController(
                noteId: "big", session: try store.openEditor(id: "big"), imageRoot: root)
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 700))
            let tv = controller.textView
            tv.frame = window.bounds
            window.addSubview(tv)
            window.isHidden = false
            tv.layoutIfNeeded()
            _ = tv.becomeFirstResponder()
            func key(_ s: String) {
                if tv.delegate?.textView?(
                    tv, shouldChangeTextIn: tv.selectedRange, replacementText: s)
                    ?? true
                {
                    tv.insertText(s)
                }
            }
            // A light command (a caret) first: it runs right on the main thread.
            tv.selectedRange = NSRange(location: 1000, length: 0)
            key("b")
            try await Task.sleep(nanoseconds: 300_000_000)
            setenv("FUTO_SLOW_WRITE_MS", "600", 1)
            var lightDone = false
            controller.checkpoint { lightDone = true }
            Thread.sleep(forTimeInterval: 0.05)
            let lightMs = ms {
                controller.runCommand("light") { session, expected in
                    _ = try session.revision()
                    return nil
                }
            }
            while !lightDone { try await Task.sleep(nanoseconds: 5_000_000) }
            record(
                "TFCONTENTION job light command (caret) during a 600ms save: runCommand() ran on the"
                    + " main thread and took \(String(format: "%.1f", lightMs))ms")
            try await Task.sleep(nanoseconds: 300_000_000)
            // Now the heavy one: Select All over the whole note, a dirty draft, a slow save.
            key("b")
            // Select All.
            tv.selectedRange = NSRange(location: 0, length: (tv.text ?? "").utf16.count)
            try await Task.sleep(nanoseconds: 300_000_000)
            var saveDone = false
            let saveStart = CACurrentMediaTime()
            controller.checkpoint { saveDone = true }
            Thread.sleep(forTimeInterval: 0.05)
            let askMs = ms { controller.runCommand("probe") { _, _ in nil } }
            let busy = controller.engineBusy
            let length = (tv.text ?? "").utf16.count
            let keyMs = ms { key("c") }
            let kept = (tv.text ?? "").utf16.count == length
            let probeAt = (CACurrentMediaTime() - saveStart) * 1000
            while controller.engineBusy { try await Task.sleep(nanoseconds: 5_000_000) }
            let freeAt = (CACurrentMediaTime() - saveStart) * 1000
            while !saveDone { try await Task.sleep(nanoseconds: 5_000_000) }
            unsetenv("FUTO_SLOW_WRITE_MS")
            record(
                "TFCONTENTION job saveSlowWrite=600ms | runCommand() took \(String(format: "%.1f", askMs))ms,"
                    + " engineBusy=\(busy) at +\(String(format: "%.0f", probeAt))ms | keystroke took"
                    + " \(String(format: "%.1f", keyMs))ms, text kept (key dropped)=\(kept)"
                    + " | input accepted again at +\(String(format: "%.0f", freeAt))ms")
            _ = await controller.close()
        }
    }
#endif

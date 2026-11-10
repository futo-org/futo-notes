#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// The app's own `NotesStore` on a real vault with a text-first editor attached to one note, for
    /// the saves that go wrong: the vault directory loses its write bit (a persistent write
    /// failure), or a peer changes the note's file behind the editor (a sync cycle's write).
    @MainActor
    final class TextFirstVaultRig {
        let scratch: URL
        let root: URL
        let store: NotesStore
        private(set) var controller: TextFirstEditorController
        let window: UIWindow
        /// The engine handle a sync cycle uses: it reaches the same attachments by vault root.
        let peer: NoteStore
        var tv: TextFirstTextView { controller.textView }
        /// What the screen's callbacks would have been told.
        private(set) var checkpoints: [FlushDraftResult] = []
        private(set) var failures: [Error] = []

        /// `opening`: a long note's quick first screens with the engine's open still pending
        /// (`failingOpen`: it never lands).
        init(
            id: String = "note", body: String, opening: Bool = false, failingOpen: Bool = false
        ) async throws {
            scratch = FileManager.default.temporaryDirectory.appendingPathComponent(
                "text-first-rig-\(UUID().uuidString)")
            root = scratch.appendingPathComponent("notes")
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            store = NotesStore(
                notesRoot: root, searchIndex: scratch.appendingPathComponent("index"))
            while !store.hasBootstrapped { await Task.yield() }
            guard let created = await store.createNote(title: id) else {
                throw RigError.createFailed
            }
            guard case .committed = await store.write(created, content: body) else {
                throw RigError.createFailed
            }
            peer = NoteStore(notesRoot: root.path)
            if opening, let quick = await store.quickOpenView(created) {
                controller = try TextFirstEditorController(
                    noteId: created, quick: quick, imageRoot: root)
            } else {
                controller = try TextFirstEditorController(
                    noteId: created, session: try await store.openEditorSession(created),
                    imageRoot: root)
            }
            controller.verifyDivergence = true
            window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 700))
            if controller.opening {
                let store = store
                controller.opener = Task {
                    if failingOpen { throw RigError.createFailed }
                    return try await store.openEditorSession(created)
                }
            }
            observe()
            mount()
        }

        private func observe() {
            controller.onCheckpoint = { [unowned self] in checkpoints.append($0) }
            controller.onFailure = { [unowned self] in failures.append($0) }
        }

        enum RigError: Error { case createFailed }

        private func mount() {
            tv.frame = window.bounds
            window.addSubview(tv)
            window.isHidden = false
            tv.layoutIfNeeded()
            _ = tv.becomeFirstResponder()
        }

        /// A user's note screen attaching again (an editor re-opened on the same vault).
        func adopt(_ again: TextFirstEditorController) {
            controller = again
            observe()
            mount()
        }

        var source: String { (try? controller.session.sourceText()) ?? "" }
        var display: String { tv.text ?? "" }
        var engineDisplay: String { (try? controller.session.displayText()) ?? "" }
        var engineRevision: UInt64 { (try? controller.session.revision()) ?? 0 }

        func select(_ a: Int, _ b: Int? = nil) {
            tv.selectedRange = NSRange(location: a, length: (b ?? a) - a)
        }

        func selectEnd() { select(display.utf16.count) }

        /// One keyboard key: the delegate is asked first, as UIKeyboardImpl does, then UIKit inserts.
        func type(_ text: String) {
            for character in text {
                let s = String(character)
                if tv.delegate?.textView?(
                    tv, shouldChangeTextIn: tv.selectedRange, replacementText: s) ?? true
                {
                    tv.insertText(s)
                }
            }
        }

        // MARK: failures

        func blockWrites() {
            #expect(chmod(root.path, 0o555) == 0)
        }

        func allowWrites() {
            #expect(chmod(root.path, 0o755) == 0)
        }

        /// A peer's sync cycle renamed the note's file and told the engine so.
        func peerRename(_ from: String, to: String) throws {
            try FileManager.default.moveItem(
                at: root.appendingPathComponent("\(from).md"),
                to: root.appendingPathComponent("\(to).md"))
            _ = try peer.refreshExternalChanges(
                updatedIds: [], deletedIds: [],
                renamed: [RenamePair(fromId: from, toId: to)])
        }

        /// A peer (or another tool) wrote the note's file; the engine hears nothing.
        func peerWrite(_ id: String, _ text: String) throws {
            try text.write(
                to: root.appendingPathComponent("\(id).md"), atomically: true, encoding: .utf8)
        }

        func disk(_ id: String) -> String? {
            try? String(contentsOf: root.appendingPathComponent("\(id).md"), encoding: .utf8)
        }

        /// Spin the main loop until `condition` holds.
        func until(_ seconds: Double = 5, _ condition: () -> Bool) async -> Bool {
            let deadline = Date().addingTimeInterval(seconds)
            while !condition() && Date() < deadline {
                try? await Task.sleep(nanoseconds: 20_000_000)
            }
            return condition()
        }

        /// A checkpoint, awaited: true when the write the checkpoint asked for was reported saved.
        @discardableResult
        func checkpoint() async -> Bool {
            let before = checkpoints.count
            await withCheckedContinuation { done in
                controller.checkpoint { done.resume() }
            }
            return checkpoints.count > before
        }

        func tearDown() {
            allowWrites()
            window.isHidden = true
            try? FileManager.default.removeItem(at: scratch)
        }
    }
#endif

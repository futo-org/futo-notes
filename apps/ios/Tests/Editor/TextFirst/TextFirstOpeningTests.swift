#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// A long note shows its first screens (the engine's quick open) read-only while the whole open
    /// runs, takes input in order, and hands over to the engine's session without changing what the
    /// view shows. docs/spec/editor/performance/android-text-first.md.
    @Suite @MainActor
    struct TextFirstOpeningTests {
        /// A note longer than the 16 KB the quick open reads, in blocks that end on blank lines.
        static func note(sections: Int = 700) -> String {
            (0..<sections).map { i in
                "## Section \(i)\n\nBody line \(i) with **bold** and a [link](https://example.com).\n\n"
            }.joined()
        }

        /// An editor opened the long way round: the quick view first, the session separately.
        @MainActor final class Opening {
            let root: URL
            let store: NoteStore
            let controller: TextFirstEditorController
            let window: UIWindow
            var tv: TextFirstTextView { controller.textView }

            init(_ source: String, id: String = "long") throws {
                root = FileManager.default.temporaryDirectory.appendingPathComponent(
                    "text-first-opening-\(UUID().uuidString)")
                try FileManager.default.createDirectory(
                    at: root, withIntermediateDirectories: true)
                store = NoteStore(notesRoot: root.path)
                _ = try store.createNote(title: id, folder: "", content: source)
                let quick = try #require(store.quickOpenView(id: id))
                controller = try TextFirstEditorController(
                    noteId: id, quick: quick, imageRoot: root)
                window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 700))
                tv.frame = window.bounds
                window.addSubview(tv)
                window.isHidden = false
                tv.layoutIfNeeded()
            }

            func land(id: String = "long") throws {
                try controller.attach(session: try store.openEditor(id: id))
            }

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
        }

        @Test func aLongNoteShowsItsFirstScreensStyledAndReadOnlyBeforeTheEngineLands() throws {
            let source = Self.note()
            let o = try Opening(source)
            #expect(o.controller.opening)
            let shown = o.tv.text ?? ""
            #expect(shown.hasPrefix("Section 0\n\nBody line 0 with bold and a link.\n"))
            #expect(shown.utf16.count < 20_000 && shown.utf16.count > 10_000)
            // Styles are the engine's: the heading is large, the bold word is bold.
            let heading = try #require(
                o.controller.storage.attribute(.font, at: 3, effectiveRange: nil) as? UIFont)
            #expect(heading.pointSize > 20)
            // The toolbar's edit buttons are disabled until the engine lands.
            #expect(o.controller.toolbarState.disabledFormats.contains("bold"))
            // A short note has no quick open.
            let short = NoteStore(notesRoot: o.root.path)
            _ = try short.createNote(title: "short", folder: "", content: "# small\n")
            #expect(short.quickOpenView(id: "short") == nil)
        }

        @Test func theHandoverAppendsTheRestAndKeepsWhatTheViewShowed() async throws {
            let source = Self.note()
            let o = try Opening(source)
            let before = NSAttributedString(attributedString: o.controller.storage)
            o.tv.contentOffset.y = 300
            try o.land()
            #expect(!o.controller.opening)
            let session = o.controller.session
            #expect(o.tv.text == (try session.displayText()))
            #expect(o.controller.mirrorLength == (o.tv.text ?? "").utf16.count)
            // What was shown is untouched: same text and the same styles.
            let kept = o.controller.storage.attributedSubstring(
                from: NSRange(location: 0, length: before.length))
            #expect(kept.string == before.string)
            #expect(o.tv.contentOffset.y == 300)
            #expect(o.controller.toolbarState.disabledFormats.contains("bold") == false)
            // The rest is styled as the engine plans it (in slices).
            let ok = o.controller.storage.length - 100
            var styled = false
            for _ in 0..<2_000 where !styled {
                try await Task.sleep(nanoseconds: 10_000_000)
                styled = o.controller.styledThrough >= o.controller.mirrorLength
            }
            #expect(styled)
            #expect(
                (o.controller.storage.attribute(.font, at: ok - 200, effectiveRange: nil)
                    as? UIFont) != nil)
        }

        /// The same keys typed into an editor that opened whole: what the queue must reproduce.
        private func reference(_ source: String, _ act: (TextFirstHarness) -> Void) throws
            -> (display: String, source: String)
        {
            let h = TextFirstHarness(source, id: "long")
            act(h)
            return (h.tv.text ?? "", try h.controller.session.sourceText())
        }

        @Test func keysTypedWhileOpeningWaitAndAreAppliedInOrderOnce() throws {
            let source = Self.note()
            let o = try Opening(source)
            let before = o.tv.text
            o.type("ab")
            _ = o.tv.delegate?.textView?(
                o.tv, shouldChangeTextIn: o.tv.selectedRange, replacementText: "\n")
            o.type("cd")
            // Nothing changed on screen, nothing written.
            #expect(o.tv.text == before)
            try o.land()
            let session = o.controller.session
            let expected = try reference(source) { h in
                h.type("ab")
                _ = h.tv.delegate?.textView?(
                    h.tv, shouldChangeTextIn: h.tv.selectedRange, replacementText: "\n")
                h.type("cd")
            }
            #expect(
                (o.tv.text ?? "").hasPrefix("ab\ncd") || (o.tv.text ?? "").hasPrefix("ab\n\ncd"))
            #expect(o.tv.text == expected.display)
            #expect(try session.sourceText() == expected.source)
            // The caret is after what was typed.
            #expect(
                o.tv.selectedRange == NSRange(location: 5, length: 0)
                    || o.tv.selectedRange.location == 6)
            #expect(o.controller.engineSelection == o.tv.selectedRange)
        }

        @Test func aTapWhileOpeningIsTakenWhenTheEngineLandsMappedThroughEarlierEdits() throws {
            let source = Self.note()
            let o = try Opening(source)
            o.type("xy")
            o.tv.selectedRange = NSRange(location: 50, length: 0)
            o.type("z")
            try o.land()
            // "xy" at the start, "z" where the finger was (50 in the text it saw, 52 after "xy").
            let expected = try reference(source) { h in
                h.type("xy")
                h.tv.selectedRange = NSRange(location: 52, length: 0)
                h.type("z")
            }
            #expect(o.tv.text == expected.display)
            #expect(Array((o.tv.text ?? "").utf16)[52] == UInt16(0x7A))
            #expect(o.controller.engineSelection == NSRange(location: 53, length: 0))
        }

        @Test func aLeaveBeforeTheEngineLandsStillSavesWhatWasTyped() async throws {
            let source = Self.note()
            let o = try Opening(source)
            o.type("q")
            let store = o.store
            o.controller.opener = Task { try store.openEditor(id: "long") }
            let result = await o.controller.close()
            guard case .success = result else {
                Issue.record("the leave failed: \(result)")
                return
            }
            let expected = try reference(source) { $0.type("q") }
            let saved = try store.read(id: "long")
            #expect(saved.hasPrefix(String(expected.source.prefix(200))))
            #expect(saved.count > source.count)
        }

        // MARK: large commands and background styling

        private func bold(_ font: UIFont?) -> Bool {
            font?.fontDescriptor.symbolicTraits.contains(.traitBold) ?? false
        }

        @Test func selectAllThenBoldRunsOffTheMainThreadAndDropsInputMeanwhile() async throws {
            let source = Self.note(sections: 1300)
            let h = TextFirstHarness(source, id: "long")
            _ = await h.until(60) { h.controller.styledThrough >= h.controller.mirrorLength }
            h.tv.selectAll(nil)
            #expect(h.controller.engineSelection.length == h.controller.mirrorLength)
            // UIKit highlights only the stretch around the viewport.
            #expect(h.controller.selectAllClipped)
            #expect(h.tv.selectedRange.length < h.controller.mirrorLength / 2)
            #expect(h.controller.engineSelection.length >= TextFirstEditorController.heavySelection)

            h.controller.format(.bold)
            // The call returned at once; the engine works on its own queue.
            #expect(h.controller.commandRunning)
            let before = h.tv.text
            // A toolbar tap and a key made meanwhile are not applied.
            let italic = try #require(
                ToolbarSpec.groups.joined().first { $0.id == "italic" })
            h.controller.toolbar(italic)
            h.type("Z")
            #expect(h.tv.text == before)
            #expect(h.controller.commandRunning)

            #expect(await h.until(60) { !h.controller.commandRunning })
            _ = await h.until(60) { h.controller.styledThrough >= h.controller.mirrorLength }
            // Only Bold was applied, to the whole note, and the view agrees with the engine.
            let source2 = try h.controller.session.sourceText()
            #expect(source2.hasPrefix("## **Section 0**") || source2.contains("**Section 0**"))
            #expect(!source2.contains("*Section 0*") || source2.contains("**Section 0**"))
            #expect(!source2.contains("Z"))
            #expect(h.tv.text == (try h.controller.session.displayText()))
            #expect(h.controller.divergences.isEmpty)
            let middle = h.controller.mirrorLength / 2
            #expect(
                bold(
                    h.controller.storage.attribute(.font, at: middle, effectiveRange: nil)
                        as? UIFont))
            // Typing works again and lands where the caret is.
            h.tv.selectedRange = NSRange(location: 5, length: 0)
            #expect(
                await h.until { h.controller.engineSelection == NSRange(location: 5, length: 0) })
            h.type("Q")
            #expect(try h.controller.session.sourceText().contains("Q"))
        }

        @Test func copyAfterSelectAllIsTheWholeNote() async throws {
            let source = Self.note(sections: 1300)
            let h = TextFirstHarness(source, id: "long")
            h.tv.selectAll(nil)
            #expect(
                h.controller.engineSelection
                    == NSRange(location: 0, length: h.controller.mirrorLength))
            _ = await h.until(30) { !h.controller.commandRunning }
            h.controller.copySelection()
            let copied = try #require(UIPasteboard.general.string)
            #expect(
                TextFirstHarness.trimmed(copied)
                    == TextFirstHarness.trimmed(try h.controller.session.sourceText()))
            #expect(copied.utf8.count > 60_000)
        }

        @Test func backgroundStylingWaitsForAFingerAndAnOpenMenu() async throws {
            let h = TextFirstHarness(Self.note(sections: 1300), id: "long")
            let before = h.controller.styledThrough
            #expect(before < h.controller.mirrorLength)
            h.tv.fingerIsDown = true
            try await Task.sleep(nanoseconds: 300_000_000)
            #expect(h.controller.styledThrough == before)
            // The edit menu holds it too, after the finger lifts.
            h.controller.menuVisible = true
            h.tv.fingerIsDown = false
            h.controller.renderHoldChanged()
            try await Task.sleep(nanoseconds: 300_000_000)
            #expect(h.controller.styledThrough == before)
            h.controller.menuVisible = false
            h.controller.renderHoldChanged()
            #expect(await h.until(60) { h.controller.styledThrough >= h.controller.mirrorLength })
        }

        @Test func typingOverAClippedSelectAllReplacesTheWholeNoteAndScrollingMovesTheHighlight()
            async throws
        {
            let h = TextFirstHarness(Self.note(sections: 1300), id: "long")
            _ = await h.until(60) { h.controller.styledThrough >= h.controller.mirrorLength }
            h.tv.selectAll(nil)
            #expect(await h.until(30) { !h.controller.commandRunning })
            #expect(h.controller.selectAllClipped)
            let first = h.tv.selectedRange
            // Scrolling far moves the highlighted stretch with the viewport.
            h.tv.contentOffset.y = h.tv.contentSize.height - 800
            h.tv.layoutIfNeeded()
            h.controller.viewportMoved()
            #expect(h.tv.selectedRange != first)
            #expect(NSMaxRange(h.tv.selectedRange) > NSMaxRange(first))
            #expect(h.controller.engineSelection.length == h.controller.mirrorLength)
            // A key replaces the engine's whole selection, not the highlighted stretch.
            h.type("x")
            let typed = try h.controller.session.sourceText()
            // The whole note went (a heading keeps its hidden marker, as for a native Select All).
            #expect(
                typed.hasSuffix("x") && typed.count < 10,
                "source is \(typed.prefix(60).debugDescription)")
            #expect(h.tv.text == "x")
            #expect(!h.controller.selectAllClipped)
        }

        @Test func aFindOverALongNoteScansOnTheEnginesQueueAndKeepsTheLatestQuery() async throws {
            let h = TextFirstHarness(Self.note(sections: 4500), id: "long")
            #expect(h.controller.mirrorLength >= TextFirstEditorController.findInBackgroundAbove)
            _ = await h.until(60) { h.controller.styledThrough >= h.controller.mirrorLength }
            h.controller.setFindQuery("Section 4")
            #expect(h.controller.commandRunning)
            // Typing on: only the last query is scanned once the first scan ends.
            h.controller.setFindQuery("Section 44")
            h.controller.setFindQuery("Body line 4499")
            #expect(await h.until(60) { !h.controller.commandRunning })
            #expect(await h.until(60) { h.controller.findModel.total == 1 })
            #expect(h.controller.find.open)
            h.controller.closeFind()
            #expect(await h.until(10) { !h.controller.find.open })
        }

        @Test func aClosedEditorAndItsBuffersAreReleasedWhenItsScreenLetsGo() async throws {
            weak var weakController: TextFirstEditorController?
            weak var weakView: UITextView?
            do {
                let h = TextFirstHarness(Self.note(sections: 300), id: "long")
                weakController = h.controller
                weakView = h.tv
                _ = await h.until(30) { h.controller.styledThrough >= h.controller.mirrorLength }
                _ = await h.controller.close()
                h.tv.removeFromSuperview()
            }
            for _ in 0..<20 where weakController != nil || weakView != nil {
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            #expect(weakController == nil)
            #expect(weakView == nil)
        }
    }
#endif

#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// A note of thousands of screens, scrolled far from its first lines. TextKit 2 lays out only the
    /// viewport and places it from an estimate of the heights above it, so a layout request far from
    /// the viewport re-bases the estimate. UIKit's tap handling makes two (the origin, then the
    /// previous caret) before it hit-tests the touch; the caret must still land where the finger is.
    @Suite @MainActor
    struct TextFirstLongNoteTests {
        /// Blocks of a heading, paragraphs, a list and now and then a quote: the shape of a long
        /// note whose estimated height differs most from its real one (short lines among long).
        static func longNote(sections: Int) -> String {
            var out = "# Long note\n\n"
            for i in 1...sections {
                out += "## Section \(i)\n\n"
                out +=
                    "Fox jumps lazy idea fox project brown over recipe travel *jumps* design. Travel river dog swift coffee lazy notes idea lazy jumps. Over swift chapter engine budget ~~keyboard~~ jumps dog travel \(i).\n\n"
                if i % 2 == 0 {
                    out +=
                        "Chapter weekend jumps over phone book jumps fox swift budget keyboard. `over` morning budget **review** phone garden recipe phone travel draft plan meeting river. Fox weekend review review review review lazy ~~book~~ review fox notes jumps project budget morning. Weekend book book swift **over** river lazy engine editor book morning quick project.\n\n"
                }
                out +=
                    "- [ ] Notes design **review** **meeting** notes.\n- [x] Draft budget draft idea over.\n- The book draft over dog.\n  - nested item \(i)\n\n"
                if i % 3 == 0 { out += "> a quoted thought \(i)\n\n" }
            }
            return out
        }

        /// Open the note, wait for its styling, and scroll to its end a screen or two at a time, as
        /// a reader's flicks do, so that TextKit has laid out its way down.
        private func openAtTheEnd() async -> TextFirstHarness {
            let h = TextFirstHarness(Self.longNote(sections: 400))
            _ = await h.until(30) { h.controller.styledThrough >= h.controller.mirrorLength }
            let tv = h.tv
            let manager = tv.textLayoutManager!
            tv.layoutIfNeeded()
            for _ in 0..<1_000 {
                let bottom = max(0, tv.contentSize.height - tv.bounds.height)
                tv.contentOffset.y = min(bottom, tv.contentOffset.y + 2_500)
                tv.layoutIfNeeded()
                let shownEnd = manager.textViewportLayoutController.viewportRange.map {
                    manager.offset(from: manager.documentRange.location, to: $0.endLocation)
                }
                if shownEnd ?? 0 >= h.controller.mirrorLength - 1, tv.contentOffset.y >= bottom - 1
                {
                    break
                }
            }
            return h
        }

        /// The heading on screen nearest the top, with the point just right of its last glyph.
        private func visibleHeading(in tv: UITextView) -> (end: Int, point: CGPoint)? {
            guard let manager = tv.textLayoutManager,
                let shown = manager.textViewportLayoutController.viewportRange
            else { return nil }
            let text = tv.text as NSString
            var found: (Int, CGPoint)?
            manager.enumerateTextLayoutFragments(from: shown.location, options: []) { fragment in
                let start = manager.offset(
                    from: manager.documentRange.location, to: fragment.rangeInElement.location)
                guard let line = fragment.textLineFragments.first,
                    text.substring(
                        with: NSRange(location: start, length: min(7, text.length - start))
                    ) == "Section"
                else { return true }
                let y =
                    fragment.layoutFragmentFrame.minY + tv.textContainerInset.top
                    + line.typographicBounds.midY
                guard y > tv.contentOffset.y + 40 else { return true }
                let end = text.paragraphRange(for: NSRange(location: start, length: 0))
                found = (
                    NSMaxRange(end) - 1,
                    CGPoint(
                        x: line.typographicBounds.maxX + tv.textContainerInset.left + 60, y: y)
                )
                return false
            }
            return found
        }

        @Test func aTapOnAHeadingFarFromTheTopLandsOnItAndTheViewStaysPut() async throws {
            let h = await openAtTheEnd()
            let tv = h.tv
            let (headingEnd, point) = try #require(visibleHeading(in: tv))
            let offsetBefore = tv.contentOffset.y
            let screenY = point.y - offsetBefore

            // What UIKit does for one tap: a finger is down, it probes the origin, asks where the
            // previous caret was, then hit-tests the touch and moves the selection there.
            let previous = try #require(tv.selectedTextRange)
            tv.fingerIsDown = true
            _ = tv.closestPosition(to: .zero)
            _ = tv.caretRect(for: previous.start)
            _ = tv.selectionRects(for: previous)
            let hit = try #require(tv.closestPosition(to: point))
            #expect(tv.offset(from: tv.beginningOfDocument, to: hit) == headingEnd)
            tv.selectedTextRange = tv.textRange(from: hit, to: hit)

            // Let layout and scroll-to-caret settle.
            for _ in 0..<10 {
                tv.layoutIfNeeded()
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            #expect(tv.selectedRange == NSRange(location: headingEnd, length: 0))
            #expect(abs(tv.contentOffset.y - offsetBefore) < 40)
            let caret = tv.caretRect(for: hit)
            #expect(abs(caret.midY - tv.contentOffset.y - screenY) < 40)
        }

        @Test func theKeyboardShrinksTheHostNotTheTextView() throws {
            let h = TextFirstHarness(Self.longNote(sections: 20))
            let container = TextFirstEditorContainer(textView: h.tv)
            container.frame = CGRect(x: 0, y: 0, width: 390, height: 700)
            h.window.addSubview(container)
            container.layoutIfNeeded()
            #expect(h.tv.frame == CGRect(x: 0, y: 0, width: 390, height: 700))
            #expect(h.tv.contentInset.bottom == 0)

            // SwiftUI shrinks the host for the keyboard: what it covers becomes an inset.
            container.frame.size.height = 350
            container.layoutIfNeeded()
            #expect(h.tv.frame == CGRect(x: 0, y: 0, width: 390, height: 700))
            #expect(h.tv.contentInset.bottom == 350)
            #expect(h.tv.verticalScrollIndicatorInsets.bottom == 350)

            container.frame.size.height = 700
            container.layoutIfNeeded()
            #expect(h.tv.frame.height == 700)
            #expect(h.tv.contentInset.bottom == 0)

            // A new width is a new layout: the text view follows the host.
            container.frame = CGRect(x: 0, y: 0, width: 844, height: 390)
            container.layoutIfNeeded()
            #expect(h.tv.frame == CGRect(x: 0, y: 0, width: 844, height: 390))
            #expect(h.tv.contentInset.bottom == 0)
        }

        @Test func aCaretQueryAboutOffscreenTextLaysNothingOutWhileAFingerIsDown() async throws {
            let h = await openAtTheEnd()
            let tv = h.tv
            let start = tv.beginningOfDocument
            let visible = CGRect(
                x: 0, y: tv.contentOffset.y, width: tv.bounds.width, height: tv.bounds.height)

            tv.fingerIsDown = true
            #expect(!visible.intersects(tv.caretRect(for: start)))
            #expect(tv.selectionRects(for: tv.textRange(from: start, to: start)!).isEmpty)

            // Without a finger the answer is the real geometry (the first line, at the top).
            tv.fingerIsDown = false
            #expect(tv.caretRect(for: start).minY < tv.textContainerInset.top + 10)
        }

        // MARK: M8 carry-overs

        /// What UIKit asks while a finger lands: the origin, then where the previous caret was.
        private func touchDown(_ tv: TextFirstTextView) {
            let previous = tv.selectedTextRange!
            tv.fingerIsDown = true
            _ = tv.closestPosition(to: .zero)
            _ = tv.caretRect(for: previous.start)
            _ = tv.selectionRects(for: previous)
        }

        private func settle(_ tv: UITextView) async throws {
            for _ in 0..<10 {
                tv.layoutIfNeeded()
                try await Task.sleep(nanoseconds: 50_000_000)
            }
        }

        @Test func aDoubleTapAndAHandleDragFarFromTheTopSelectWhereTheFingerIs() async throws {
            let h = await openAtTheEnd()
            let tv = h.tv
            let (headingEnd, endPoint) = try #require(visibleHeading(in: tv))
            let text = tv.text as NSString
            let headingStart = text.lineRange(for: NSRange(location: headingEnd, length: 0))
                .location
            let offsetBefore = tv.contentOffset.y

            // Double tap: the same hit test as a tap, then the word around the hit.
            touchDown(tv)
            let wordPoint = CGPoint(x: tv.textContainerInset.left + 25, y: endPoint.y)
            let hit = try #require(tv.closestPosition(to: wordPoint))
            let word = try #require(
                tv.tokenizer.rangeEnclosingPosition(
                    hit, with: .word, inDirection: .storage(.forward)))
            tv.selectedTextRange = word
            try await settle(tv)
            #expect(tv.selectedRange == NSRange(location: headingStart, length: 7))
            #expect(text.substring(with: tv.selectedRange) == "Section")
            #expect(abs(tv.contentOffset.y - offsetBefore) < 40)

            // The end handle dragged to the end of the line: the same hit test with a finger down.
            touchDown(tv)
            let dragged = try #require(tv.closestPosition(to: endPoint))
            let start = try #require(tv.selectedTextRange).start
            tv.selectedTextRange = tv.textRange(from: start, to: dragged)
            try await settle(tv)
            #expect(
                tv.selectedRange
                    == NSRange(location: headingStart, length: headingEnd - headingStart))
            #expect(abs(tv.contentOffset.y - offsetBefore) < 40)
        }

        @Test func aNewWidthKeepsTheReadersLineAtTheTop() async throws {
            let h = TextFirstHarness(Self.longNote(sections: 400))
            _ = await h.until(60) { h.controller.styledThrough >= h.controller.mirrorLength }
            let tv = h.tv
            let container = TextFirstEditorContainer(textView: tv)
            container.frame = CGRect(x: 0, y: 0, width: 390, height: 700)
            h.window.addSubview(container)
            container.layoutIfNeeded()
            tv.contentOffset.y = 40_000
            tv.layoutIfNeeded()
            let top = try #require(
                tv.closestPosition(
                    to: CGPoint(x: tv.textContainerInset.left + 1, y: tv.contentOffset.y + 1)))
            let before = tv.offset(from: tv.beginningOfDocument, to: top)

            let began = CACurrentMediaTime()
            container.frame = CGRect(x: 0, y: 0, width: 844, height: 390)
            container.layoutIfNeeded()
            tv.layoutIfNeeded()
            let tookMs = (CACurrentMediaTime() - began) * 1000
            let after = try #require(
                tv.closestPosition(
                    to: CGPoint(x: tv.textContainerInset.left + 1, y: tv.contentOffset.y + 1)))
            let now = tv.offset(from: tv.beginningOfDocument, to: after)
            // UIKit keeps the reader's line through a new width (a landscape line holds under 130
            // characters); a fixed point offset would show text thousands of characters away.
            #expect(abs(now - before) < 260, "top was \(before), is \(now)")
            print("TFBENCH width change at 40,000 pt: \(Int(tookMs)) ms")
        }

        @Test func aTallTablesCellFieldDoesNotMoveTheReaderWhenItIsPlacedFarAway() async throws {
            var source = "intro\n\n| a | b |\n|---|---|\n"
            for i in 0..<300 { source += "| row \(i) | \(i) |\n" }
            source += "\n" + Self.longNote(sections: 300)
            let h = TextFirstHarness(source)
            _ = await h.until(60) { h.controller.styledThrough >= h.controller.mirrorLength }
            h.tv.layoutIfNeeded()
            let cellOffset = (h.tv.text as NSString).range(of: "row 3 ").location
            h.controller.selectInCell(NSRange(location: cellOffset, length: 5))
            let editor = TextFirstCellEditor(controller: h.controller)
            editor.install()
            try await settle(h.tv)
            // Far away, the field is off screen; placing it asks TextKit for the cell's layout. That
            // must not lay the note out up to the cell and re-base the estimate under the reader.
            h.tv.setContentOffset(
                CGPoint(x: 0, y: max(0, h.tv.contentSize.height - 2_000)), animated: false)
            try await settle(h.tv)
            let offset = h.tv.contentOffset.y
            #expect(offset > 50_000)
            editor.reposition()
            h.tv.layoutIfNeeded()
            #expect(abs(h.tv.contentOffset.y - offset) < 1)
        }
    }
#endif

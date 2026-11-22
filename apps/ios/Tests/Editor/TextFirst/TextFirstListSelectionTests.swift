#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// A selection over list rows tints each row from its marker (or its text, where the
    /// selection does not hold the marker), never the indent before it.
    @Suite @MainActor
    struct TextFirstListSelectionTests {
        /// The selection rects over the display line holding `word`, in text view coordinates.
        private func rects(_ h: TextFirstHarness, on word: String) -> [CGRect] {
            let at = (h.tv.text as NSString).range(of: word).location
            let line = h.tv.caretRect(
                for: h.tv.position(from: h.tv.beginningOfDocument, offset: at)!)
            return h.tv.selectionRects(for: h.tv.selectedTextRange!).map(\.rect).filter {
                $0.width > 0 && $0.minY < line.midY && $0.maxY > line.midY
            }
        }

        /// The x where the marker unit before `word` starts.
        private func markerX(_ h: TextFirstHarness, _ word: String) -> CGFloat {
            let at = (h.tv.text as NSString).range(of: word).location - 1
            return h.tv.caretRect(for: h.tv.position(from: h.tv.beginningOfDocument, offset: at)!)
                .minX
        }

        @Test func aSelectionAcrossNestedRowsStartsEachRowAtItsMarker() {
            let h = TextFirstHarness(
                "- Bullet alpha\n- Bullet beta\n  - Nested bullet gamma\n    - Third level delta\n")
            h.tv.layoutIfNeeded()
            let text = h.tv.text as NSString
            let from = text.range(of: "Bullet beta").location + 3
            let to = text.range(of: "Third level").location + 9
            h.select(from, to)
            // The first row from where the selection starts in its text, not its marker.
            let startX = h.tv.caretRect(
                for: h.tv.position(from: h.tv.beginningOfDocument, offset: from)!
            ).minX
            for rect in rects(h, on: "Bullet beta") {
                #expect(
                    rect.minX >= startX - 1, "Bullet beta: tint from \(rect.minX), start \(startX)")
            }
            // A row the selection holds whole is tinted from its marker through its text; the
            // last row from its marker to where the selection ends.
            func caretX(_ offset: Int) -> CGFloat {
                h.tv.caretRect(for: h.tv.position(from: h.tv.beginningOfDocument, offset: offset)!)
                    .minX
            }
            let gammaEnd = caretX(NSMaxRange(text.range(of: "Nested bullet gamma")))
            for (word, end) in [
                ("Nested bullet gamma", gammaEnd), ("Third level delta", caretX(to)),
            ] {
                let found = rects(h, on: word)
                let left = found.map(\.minX).min() ?? .infinity
                let right = found.map(\.maxX).max() ?? -.infinity
                #expect(
                    abs(left - markerX(h, word)) < 1.5,
                    "\(word): tint from \(left), marker at \(markerX(h, word))")
                #expect(right >= end - 1, "\(word): tint to \(right), text to \(end)")
                if word.hasPrefix("Third") {
                    #expect(
                        abs(right - end) < 1.5, "\(word): tint to \(right), selection to \(end)")
                }
            }
        }

        @Test func aRowSelectedFromItsTextStartIsTintedFromItsText() {
            let h = TextFirstHarness("- a\n  - nested words here\n- b\n")
            h.tv.layoutIfNeeded()
            let text = h.tv.text as NSString
            let start = text.range(of: "nested").location
            h.select(start, text.range(of: "b\n").location + 1)
            let textX = h.tv.caretRect(
                for: h.tv.position(from: h.tv.beginningOfDocument, offset: start)!
            ).minX
            for rect in rects(h, on: "nested") {
                #expect(rect.minX >= textX - 1, "from \(rect.minX), text at \(textX)")
            }
        }

        /// A selection starting inside a right-to-left run of a left-to-right item still tints
        /// the text after that run (Copy holds it, so the tint must too).
        @Test func aSelectionFromInsideARightToLeftRunTintsTheRestOfTheRow() throws {
            let h = TextFirstHarness("- abc אבג def\n- next\n")
            h.tv.layoutIfNeeded()
            let text = h.tv.text as NSString
            let from = text.range(of: "בג").location
            h.select(from, text.range(of: "next").location + 2)
            #expect(try h.controller.selectionMarkdown(h.tv.selectedRange).contains("def"))
            let def = text.range(of: "def")
            let x = h.tv.caretRect(
                for: h.tv.position(from: h.tv.beginningOfDocument, offset: def.location + 1)!
            ).midX
            let covered = rects(h, on: "def").contains { $0.minX <= x && $0.maxX >= x }
            #expect(covered, "def at \(x) in \(rects(h, on: "def"))")
        }

        /// A left-to-right item's wrapped row that begins inside a right-to-left run, selected
        /// whole: the row is tinted across all of its text, the run's far side included.
        @Test func aWrappedRowStartingInsideARightToLeftRunIsTintedWhole() throws {
            let hebrew = Array(repeating: "שלום עולם", count: 6).joined(separator: " ")
            let h = TextFirstHarness("- alpha beta gamma delta epsilon \(hebrew) tail\n- next\n")
            h.tv.layoutIfNeeded()
            let text = h.tv.text as NSString
            let manager = try #require(h.tv.textLayoutManager)
            let fragment = try #require(
                manager.textLayoutFragment(for: manager.documentRange.location))
            let lines = fragment.textLineFragments.filter { $0.characterRange.length > 0 }
            try #require(lines.count >= 2)
            let second = lines[1]
            let run = text.range(of: hebrew)
            // The second row must begin inside the run.
            try #require(
                second.characterRange.location > run.location
                    && second.characterRange.location < NSMaxRange(run) - 1)
            let origin = CGPoint(
                x: h.tv.textContainerInset.left + fragment.layoutFragmentFrame.minX
                    + second.typographicBounds.minX,
                y: h.tv.textContainerInset.top + fragment.layoutFragmentFrame.minY
                    + second.typographicBounds.minY)
            let xs = (second.characterRange.location..<NSMaxRange(second.characterRange)).map {
                origin.x + second.locationForCharacter(at: $0).x
            }
            let midY = origin.y + second.typographicBounds.height / 2
            h.select(1, text.range(of: "next").location + 2)
            let rowRects = h.tv.selectionRects(for: h.tv.selectedTextRange!).map(\.rect).filter {
                $0.width > 0 && $0.minY < midY && $0.maxY > midY
            }
            let left = rowRects.map(\.minX).min() ?? .infinity
            let right = rowRects.map(\.maxX).max() ?? -.infinity
            #expect(left <= xs.min()! + 1, "tint from \(left), row's text from \(xs.min()!)")
            #expect(right >= xs.max()! - 1, "tint to \(right), row's text to \(xs.max()!)")
        }

        /// UIKit can hand over one rect spanning two rows that holds both of the selection's
        /// ends. Split per row, the start's handle stays on the start's row and the end's on
        /// the end's, each exactly once.
        @Test func aRectSplitAcrossRowsKeepsEachHandleOnItsEndsRow() throws {
            let h = TextFirstHarness("- first item\n- second item\n- third\n")
            h.tv.layoutIfNeeded()
            let text = h.tv.text as NSString
            let from = text.range(of: "first").location + 2
            let to = text.range(of: "second").location + 3
            h.select(from, to)
            func caret(_ offset: Int) -> CGRect {
                h.tv.caretRect(for: h.tv.position(from: h.tv.beginningOfDocument, offset: offset)!)
            }
            let (top, bottom) = (caret(from), caret(to))
            let source = try #require(h.tv.selectionRects(for: h.tv.selectedTextRange!).first)
            let both = TextFirstSelectionRect(
                source,
                drawnAs: CGRect(
                    x: 0, y: top.minY, width: h.tv.bounds.width, height: bottom.maxY - top.minY),
                containsStart: true, containsEnd: true)
            let pieces = h.controller.listRowSelectionRects([both], of: h.tv.selectedRange)
            let starts = pieces.filter(\.containsStart).map(\.rect)
            let ends = pieces.filter(\.containsEnd).map(\.rect)
            try #require(starts.count == 1 && ends.count == 1, "\(pieces.map(\.rect))")
            #expect(starts[0].minY <= top.midY && top.midY <= starts[0].maxY, "\(starts)")
            #expect(ends[0].minY <= bottom.midY && bottom.midY <= ends[0].maxY, "\(ends)")
        }
    }
#endif

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
            for word in ["Nested bullet gamma", "Third level delta"] {
                let found = rects(h, on: word)
                #expect(!found.isEmpty, "\(word) is tinted")
                for rect in found {
                    #expect(
                        rect.minX >= markerX(h, word) - 1,
                        "\(word): tint from \(rect.minX), marker at \(markerX(h, word))")
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
    }
#endif

#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// A list item's marker: its unit's width and caret stops, where its bullet, number or box is
    /// drawn, how a line wraps beside it, typing beside it, and the list keys. Touch is
    /// TextFirstListMarkerTouchTests.
    @Suite @MainActor
    struct TextFirstListMarkerTests {
        @Test func anEmptyTaskKeepsItsCheckboxPositionWhenTypedInto() {
            let h = TextFirstHarness("- [ ] first\n- [ ] \n- [ ] last")
            // After the empty task's marker unit.
            let at = (h.tv.text as NSString).range(of: "\n").location + 2
            func boxes() -> [CGFloat] {
                h.tv.layoutIfNeeded()
                let manager = h.tv.textLayoutManager!
                var centers: [CGFloat] = []
                manager.enumerateTextLayoutFragments(
                    from: manager.documentRange.location, options: []
                ) { fragment in
                    if let box = (fragment as? TextFirstLayoutFragment)?.checkboxRect {
                        centers.append(fragment.layoutFragmentFrame.minY + box.midY)
                    }
                    return true
                }
                return centers
            }
            h.select(at, at)
            let empty = boxes()
            #expect(empty.count == 3, "a box on each task: \(empty)")
            h.type("G")
            #expect(empty == boxes(), "empty \(empty), typed \(boxes())")
        }

        /// Every list marker sits on the middle of its text's capital letters, whether the row is
        /// empty or typed into. Measured on the rendered pixels (the marker's ink against the
        /// text's), so it holds whatever geometry the layout reports.
        @Test func listMarkersCenterOnTheirTextAndStayPutWhenTypedInto() {
            let h = TextFirstHarness(
                "- HI\n\n1. HI\n\n- [ ] HI\n- [x] HI\n\n- HI\n  - HI\n  - [ ] HI\n\n- [ ] \n")
            let rows = inkCenters(h)
            #expect(rows.count == 8, "\(rows)")
            for row in rows where row.text != nil {
                #expect(abs(row.marker - row.text!) < 0.5, "\(row)")
            }
            // Typing into the empty last task moves its box by nothing and lands it on the text.
            let before = rows.last!
            let display = h.tv.text as NSString
            let end = display.length - (display.hasSuffix("\n") ? 1 : 0)
            h.select(end, end)
            h.type("H")
            let after = inkCenters(h).last!
            #expect(abs(after.marker - before.marker) < 0.01, "\(before) -> \(after)")
            #expect(abs(after.marker - after.text!) < 0.5, "\(after)")
        }

        /// Per list row, the vertical center of the ink left of the text (the marker) and of the
        /// ink right of it (the text), in points.
        private func inkCenters(_ h: TextFirstHarness) -> [(marker: CGFloat, text: CGFloat?)] {
            h.tv.tintColor = .clear  // the caret is ink too
            h.tv.layoutIfNeeded()
            let scale: CGFloat = 4
            let format = UIGraphicsImageRendererFormat()
            format.scale = scale
            let image = UIGraphicsImageRenderer(size: h.tv.bounds.size, format: format).image { c in
                UIColor.white.setFill()
                c.fill(h.tv.bounds)
                h.tv.drawHierarchy(in: h.tv.bounds, afterScreenUpdates: true)
            }
            let cg = image.cgImage!
            var pixels = [UInt8](repeating: 0, count: cg.width * cg.height * 4)
            let context = CGContext(
                data: &pixels, width: cg.width, height: cg.height, bitsPerComponent: 8,
                bytesPerRow: cg.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            context.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
            func isInk(_ x: Int, _ y: Int) -> Bool {
                let i = (y * cg.width + x) * 4
                return Int(pixels[i]) + Int(pixels[i + 1]) + Int(pixels[i + 2]) < 3 * 200
            }
            func inkCenter(xs: Range<Int>, ys: Range<Int>) -> CGFloat? {
                let inked = ys.filter { y in xs.contains { isInk($0, y) } }
                guard let first = inked.first, let last = inked.last else { return nil }
                return CGFloat(first + last + 1) / 2 / scale
            }
            // The rows are the bands of ink across the whole width, top to bottom (the render's
            // origin is not the text layout's, so no band is predicted from geometry).
            var bands: [Range<Int>] = []
            var open: Int?
            for y in 0..<cg.height {
                let inked = (0..<cg.width).contains { isInk($0, y) }
                if inked, open == nil { open = y }
                if !inked, let from = open {
                    bands.append(from..<y)
                    open = nil
                }
            }
            let manager = h.tv.textLayoutManager!
            let content = manager.textContentManager!
            var textXs: [Int] = []
            manager.enumerateTextLayoutFragments(
                from: manager.documentRange.location, options: [.ensuresLayout]
            ) { fragment in
                guard let row = fragment as? TextFirstLayoutFragment, row.markerUnit != nil
                else { return true }
                let start = content.offset(
                    from: manager.documentRange.location, to: fragment.rangeInElement.location)
                // The text starts after the marker unit.
                let position = h.tv.position(from: h.tv.beginningOfDocument, offset: start + 1)!
                textXs.append(Int((h.tv.caretRect(for: position).minX - 1) * scale))
                return true
            }
            #expect(bands.count == textXs.count, "\(bands) ink bands, \(textXs) rows")
            return zip(bands, textXs).map { band, textX in
                (
                    marker: inkCenter(xs: 0..<textX, ys: band) ?? -1,
                    text: inkCenter(xs: textX..<cg.width, ys: band)
                )
            }
        }

        /// The marker unit is one character as wide as its marker column, with a caret stop on
        /// each side: before it at the column's start, after it where the item's text starts.
        @Test func aMarkerUnitSpansItsColumnBetweenItsTwoCaretStops() {
            let h = TextFirstHarness("- a\n- [ ] b\n1. c\n10. d\n100) e\n")
            h.tv.layoutIfNeeded()
            let text = h.tv.text as NSString
            var widths: [String: CGFloat] = [:]
            for word in ["a", "b", "c", "d", "e"] {
                let after = text.range(of: word).location
                let unit = after - 1
                #expect(text.character(at: unit) == 0xFFFC)
                let row = h.block(atLineStartingWith: word)!
                func caretX(_ offset: Int) -> CGFloat {
                    h.tv.caretRect(
                        for: h.tv.position(from: h.tv.beginningOfDocument, offset: offset)!
                    ).minX
                }
                let width = caretX(after) - caretX(unit)
                #expect(abs(width - row.markerColumn) < 0.5, "\(word): \(width)")
                widths[row.list!.text] = width
            }
            #expect(widths["-"] == TextFirstMetrics.markerStep)
            #expect(widths["1."] == TextFirstMetrics.markerStep)
            #expect(widths["100)"]! > widths["10."]!)
            print("marker columns: \(widths)")
        }

        /// Typing just after a marker unit types visible body text, not the unit's hidden look.
        @Test func typingAfterAMarkerUnitIsPlainText() {
            let h = TextFirstHarness("- [x] done\n- \n")
            for after in [1, (h.tv.text as NSString).range(of: "\n").location + 2] {
                h.select(after, after)
                let typing = h.tv.typingAttributes
                #expect(typing[.kern] == nil)
                #expect((typing[.foregroundColor] as? UIColor) != .clear)
                #expect((typing[.font] as? UIFont)?.pointSize == 17)
            }
        }

        @Test func tabAndShiftTabIndentAndOutdentAListItem() {
            let h = TextFirstHarness("- a\n- b\n")
            h.select(3, 3)
            #expect(h.controller.paragraphKey(.tab, onlyIfChanged: true))
            #expect(h.source.hasPrefix("- a\n\t- b"))
            #expect((h.block(atLineStartingWith: "b")?.list?.indent ?? 0) > 0)
            #expect(h.controller.paragraphKey(.shiftTab, onlyIfChanged: true))
            #expect(h.source.hasPrefix("- a\n- b"))
            // Outside a list the key is UIKit's.
            let plain = TextFirstHarness("plain\n")
            plain.select(2, 2)
            #expect(!plain.controller.paragraphKey(.tab, onlyIfChanged: true))
        }

        @Test func enterContinuesAListAndBackspaceLiftsItsMarker() {
            let h = TextFirstHarness("- item\n")
            h.select(5, 5)
            _ = h.tv.delegate?.textView?(
                h.tv, shouldChangeTextIn: h.tv.selectedRange, replacementText: "\n")
            #expect(h.source.hasPrefix("- item\n- "))
            #expect(h.block(atLineStartingWith: "item")?.list?.marker == .bullet)
            #expect(h.controller.divergences.isEmpty)
        }

        /// A first word wider than the row (a long link) starts on the marker's row: the line
        /// never breaks between the marker unit and the text after it.
        @Test(
            arguments: ["- ", "- [ ] ", "10. ", "- a\n  - "],
            [
                "https://example.com/a/very/long/path/without/any/spaces/that/is/wider/than/the/whole/column",
                // No break opportunity anywhere in it.
                String(repeating: "Supercalifragilistic", count: 3),
            ])
        func aLongFirstWordStaysOnItsMarkersRow(prefix: String, word: String) {
            let h = TextFirstHarness(prefix + word + "\n")
            let start = (h.tv.text as NSString).range(of: word).location
            let lines = h.visualLines(at: start)
            #expect(lines.count > 1, "the word wraps: \(lines)")
            #expect(lines.first?.text.hasPrefix("\u{FFFC}" + word.prefix(5)) == true, "\(lines)")
        }

        /// In an item of either direction, or mixing both, the marker unit's rect is exactly its
        /// marker column, beside the text and over none of it.
        @Test(arguments: ["- [ ] 123 שלום", "- [ ] שלום", "- שלום abc", "1. abc שלום", "- abc"])
        func aMarkerUnitIsItsColumnInAnyDirection(source: String) {
            let h = TextFirstHarness(source + "\n")
            h.tv.layoutIfNeeded()
            let manager = h.tv.textLayoutManager!
            let f =
                manager.textLayoutFragment(for: manager.documentRange.location)
                as! TextFirstLayoutFragment
            let unit = f.markerUnit!
            let line = f.textLineFragments[0]
            let bounds = line.typographicBounds
            // Every text character's caret edge lies outside the unit.
            let length = line.characterRange.length
            let edges = (1...max(1, length - 1)).map {
                f.layoutFragmentFrame.minX + bounds.minX + line.locationForCharacter(at: $0).x
            }
            #expect(abs(unit.rect.width - f.block.markerColumn) < 0.5, "\(unit)")
            #expect(
                edges.allSatisfy { $0 <= unit.rect.minX + 0.5 || $0 >= unit.rect.maxX - 0.5 },
                "\(unit) \(edges)")
        }

        /// Before a long note's styling reaches it, a marker unit is a bare U+FFFC in the base
        /// look: it takes no room and draws nothing, so no replacement glyph ever shows.
        @Test func anUnstyledMarkerUnitTakesNoRoomAndDrawsNothing() {
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 200))
            let tv = UITextView(usingTextLayoutManager: true)
            tv.frame = window.bounds
            window.addSubview(tv)
            tv.attributedText = NSAttributedString(
                string: "\u{FFFC}item", attributes: TextFirstEditorController.baseAttributes)
            tv.layoutIfNeeded()
            func x(_ offset: Int) -> CGFloat {
                tv.caretRect(for: tv.position(from: tv.beginningOfDocument, offset: offset)!).minX
            }
            #expect(abs(x(1) - x(0)) < 0.5, "the unit's advance: \(x(1) - x(0))")
        }

        /// Typing with the caret just before an item's marker writes before the line's marker.
        @Test func typingBeforeAMarkerWritesBeforeIt() {
            let h = TextFirstHarness("- one\n- two\n")
            let at = (h.tv.text as NSString).range(of: "two").location - 1
            h.select(at, at)
            h.type("L")
            #expect(h.source.hasPrefix("- one\nL- two"))
        }

        /// An indented plain line continuing a list hangs at the text of the item it continues
        /// (its display level less one): in `- a`, `  - b`, `    - c`, `  continued`, under `a`.
        @Test func aContinuedPlainLineHangsAtItsItemsText() {
            let h = TextFirstHarness("- a\n  - b\n    - c\n  continued\n- d\n")
            func style(_ word: String) -> NSParagraphStyle {
                let at = (h.tv.text as NSString).range(of: word).location
                return h.controller.storage.attribute(.paragraphStyle, at: at, effectiveRange: nil)
                    as! NSParagraphStyle
            }
            #expect(h.block(atLineStartingWith: "continued")?.list?.level == 1)
            #expect(style("continued").firstLineHeadIndent == style("a\n").headIndent)
            #expect(style("continued").headIndent == style("a\n").headIndent)
        }

        /// Under a wide number the item's text starts further in; a line continuing it hangs there.
        @Test(arguments: [
            ("99. ninety nine\n100) Hundred item\n     continued under\n", "Hundred"),
            ("10. Ten item\n    continued under\n", "Ten"),
            // The engine keeps the list across a blank line.
            ("100) Hundred\n\n     continued\n", "Hundred"),
        ])
        func aContinuedLineHangsAtAWideNumbersText(source: String, item: String) {
            let h = TextFirstHarness(source)
            func style(_ word: String) -> NSParagraphStyle {
                let at = (h.tv.text as NSString).range(of: word).location
                return h.controller.storage.attribute(.paragraphStyle, at: at, effectiveRange: nil)
                    as! NSParagraphStyle
            }
            #expect(style("continued").headIndent == style(item).headIndent, "\(source)")
            #expect(style("continued").firstLineHeadIndent == style(item).headIndent)
        }
    }
#endif

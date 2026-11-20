#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// A list item's marker: its unit's width and caret stops, where its bullet, number or box is
    /// drawn, typing beside it, and the checkbox and list keys.
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

        @Test func tappingACheckboxTogglesThroughTheEngineAndKeepsTheCaret() {
            let h = TextFirstHarness("- [ ] one\n- [x] two\n")
            h.tv.layoutIfNeeded()
            h.select(1, 1)
            let manager = h.tv.textLayoutManager!
            var hit: NSTextLayoutFragment?
            manager.enumerateTextLayoutFragments(from: manager.documentRange.location, options: [])
            {
                f in
                if hit == nil, f is TextFirstLayoutFragment { hit = f }
                return hit == nil
            }
            let f = hit as! TextFirstLayoutFragment
            let box = f.checkboxRect!
            let inset = h.tv.textContainerInset
            let point = CGPoint(
                x: box.midX + inset.left, y: f.layoutFragmentFrame.minY + box.midY + inset.top)
            #expect(h.controller.checkboxFragment(at: point) === f)
            h.controller.touchHitCheckbox = true
            h.controller.selectionBeforeTouch = NSRange(location: 1, length: 0)
            h.controller.toggleTask(atLineOffset: 0)
            #expect(h.source.hasPrefix("- [x] one\n- [x] two"))
            h.controller.toggleTask(atLineOffset: 0)
            #expect(h.source.hasPrefix("- [ ] one"))
            #expect(h.controller.divergences.isEmpty)
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
        @Test(arguments: ["- ", "- [ ] ", "10. ", "- a\n  - "])
        func aLongFirstWordStaysOnItsMarkersRow(prefix: String) {
            let link = "https://example.com/a/very/long/path/without/any/spaces/that/is/wider/than/the/whole/column"
            let h = TextFirstHarness(prefix + link + "\n")
            let start = (h.tv.text as NSString).range(of: "https").location
            let lines = h.visualLines(at: start)
            #expect(lines.count > 1, "the link wraps: \(lines)")
            #expect(lines.first?.text.hasPrefix("\u{FFFC}https") == true, "\(lines)")
        }

        /// The marker unit's rect in text view coordinates, on the line holding `word`.
        private func unitRect(_ h: TextFirstHarness, _ word: String) -> CGRect {
            h.tv.layoutIfNeeded()
            let manager = h.tv.textLayoutManager!
            let at = (h.tv.text as NSString).range(of: word).location - 1
            let f =
                manager.textLayoutFragment(
                    for: manager.location(manager.documentRange.location, offsetBy: at)!)
                as! TextFirstLayoutFragment
            let inset = h.tv.textContainerInset
            return f.markerUnit!.rect.offsetBy(
                dx: inset.left, dy: f.layoutFragmentFrame.minY + inset.top)
        }

        /// A tap's caret goes to the nearer side of a bullet or number, as beside a character.
        @Test func aTapOnAMarkersHalvesPlacesTheCaretOnThatSide() {
            let h = TextFirstHarness("- one\n10. two\n")
            for word in ["one", "two"] {
                let unit = unitRect(h, word)
                let at = (h.tv.text as NSString).range(of: word).location - 1
                func caret(_ x: CGFloat) -> Int {
                    h.tv.offset(
                        from: h.tv.beginningOfDocument,
                        to: h.tv.closestPosition(to: CGPoint(x: x, y: unit.midY))!)
                }
                #expect(caret(unit.minX + 2) == at, "\(word): left half")
                #expect(caret(unit.midX - 2) == at, "\(word): left half")
                #expect(caret(unit.midX + 2) == at + 1, "\(word): right half")
                #expect(caret(unit.maxX - 2) == at + 1, "\(word): right half")
            }
        }

        /// A hold on a marker selects the unit alone; on a checkbox it ticks nothing.
        @Test func aHoldSelectsJustTheMarkerAndTicksNoBox() throws {
            let h = TextFirstHarness("- [ ] one\n- two\n")
            for word in ["one", "two"] {
                let unit = unitRect(h, word)
                let at = (h.tv.text as NSString).range(of: word).location - 1
                h.controller.touchHitCheckbox = true
                #expect(h.controller.selectMarkerUnit(at: CGPoint(x: unit.midX, y: unit.midY)))
                #expect(h.tv.selectedRange == NSRange(location: at, length: 1))
                #expect(h.controller.engineSelection == NSRange(location: at, length: 1))
                #expect(!h.controller.touchHitCheckbox)
                #expect(try h.controller.selectionMarkdown(h.tv.selectedRange)
                    == (word == "one" ? "- [ ] " : "- "))
            }
            #expect(h.source.hasPrefix("- [ ] one\n- two"))
            // Off the marker (on the text) nothing is selected by the hold.
            let text = unitRect(h, "one").offsetBy(dx: 40, dy: 0)
            #expect(!h.controller.selectMarkerUnit(at: CGPoint(x: text.midX, y: text.midY)))
        }

        /// A checkbox's touch area is its marker unit: a tap beside it on the text is the text's.
        @Test func aCheckboxIsHitOnItsMarkerUnitOnly() {
            let h = TextFirstHarness("- [ ] one\n")
            let unit = unitRect(h, "one")
            #expect(h.controller.checkboxFragment(at: CGPoint(x: unit.midX, y: unit.midY)) != nil)
            #expect(h.controller.checkboxFragment(at: CGPoint(x: unit.maxX + 4, y: unit.midY)) == nil)
        }

        /// A tick with the caret just before the task's marker leaves the caret there, and the
        /// view and the engine agree on it; the next character lands as at a caret placed there.
        @Test func aTickWithTheCaretBeforeAMarkerKeepsTheCaretAndTheEngineAgrees() {
            let h = TextFirstHarness("- [ ] one\n")
            h.select(0, 0)
            h.controller.toggleTask(atLineOffset: 0, keeping: h.tv.selectedRange)
            #expect(h.source.hasPrefix("- [x] one"))
            #expect(h.tv.selectedRange == NSRange(location: 0, length: 0))
            #expect(h.controller.engineSelection == NSRange(location: 0, length: 0))
            h.type("a")
            let fresh = TextFirstHarness("- [x] one\n")
            fresh.select(0, 0)
            fresh.type("a")
            #expect(h.source == fresh.source, "typed after the tick: \(h.source.debugDescription)")
        }
    }
#endif

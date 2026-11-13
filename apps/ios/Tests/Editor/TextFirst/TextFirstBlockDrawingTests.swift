#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    @Suite @MainActor
    struct TextFirstBlockDrawingTests {
        @Test func deletingANestedItemCanRemoveItsFirstCharacter() {
            let h = TextFirstHarness("- What about\n  - Nested\n  - Elements")
            let at = (h.tv.text as NSString).range(of: "Nested").location
            h.select(at + 6, at + 6)
            for _ in 0..<6 { h.tv.deleteBackward() }
            #expect(!h.display.contains("N"), "\(h.source.debugDescription)")
            #expect(h.controller.divergences.isEmpty)
        }

        @Test func anEmptyTaskKeepsItsCheckboxPositionWhenTypedInto() {
            let h = TextFirstHarness("- [ ] first\n- [ ] \n- [ ] last")
            let at = (h.tv.text as NSString).range(of: "\n").location + 1
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
                guard let row = fragment as? TextFirstLayoutFragment, row.block.list != nil,
                    row.block.showsMarker
                else { return true }
                let start = content.offset(
                    from: manager.documentRange.location, to: fragment.rangeInElement.location)
                let position = h.tv.position(from: h.tv.beginningOfDocument, offset: start)!
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

        @Test func aBulletCanBeAddedInsideAQuote() {
            let h = TextFirstHarness("> quoted\n> ")
            let at = (h.tv.text as NSString).range(of: "\n").location + 1
            h.select(at, at)
            h.controller.block(.bulletList)
            h.type("inside")
            #expect(h.source.contains("> - inside"), "\(h.source.debugDescription)")
            #expect(block(h, atLineStartingWith: "inside")?.quoteDepth == 1)
            #expect(block(h, atLineStartingWith: "inside")?.list?.marker == .bullet)
            #expect(h.controller.divergences.isEmpty)
        }

        private func block(_ h: TextFirstHarness, atLineStartingWith word: String)
            -> TextFirstBlockAttribute?
        {
            let at = (h.tv.text as NSString).range(of: word).location
            return h.controller.storage.attribute(.tfBlock, at: at, effectiveRange: nil)
                as? TextFirstBlockAttribute
        }

        @Test func listRowsCarryTheirMarkerNumberAndTaskState() {
            let h = TextFirstHarness("- bullet\n\n1. first\n2. second\n\n- [ ] open\n- [x] done\n")
            #expect(block(h, atLineStartingWith: "bullet")?.list?.marker == .bullet)
            #expect(block(h, atLineStartingWith: "second")?.list?.text == "2.")
            #expect(block(h, atLineStartingWith: "open")?.list?.marker == .task)
            #expect(block(h, atLineStartingWith: "open")?.list?.checked == false)
            #expect(block(h, atLineStartingWith: "done")?.list?.checked == true)
            // The markers are not characters: the display holds only the words.
            #expect(h.display.hasPrefix("bullet"))
        }

        @Test func aLooseListsBlankLineDrawsNoMarker() {
            let h = TextFirstHarness("1. first\n2. second\n\nplain\n\n- [x] done\n\nafter")
            let text = h.tv.text as NSString
            let second = text.range(of: "second").location
            let blank = second + "second".count + 0
            let b =
                h.controller.storage.attribute(.tfBlock, at: blank + 1, effectiveRange: nil)
                as? TextFirstBlockAttribute
            #expect(b == nil || b?.showsMarker == false)
            let done = block(h, atLineStartingWith: "done")
            #expect(done?.showsMarker == true)
        }

        @Test func nestedListsIndentAndQuotesDrawBars() {
            let h = TextFirstHarness("- a\n  - nested\n\n> > deep\n")
            let nested = block(h, atLineStartingWith: "nested")?.list
            #expect(nested?.indent == 2)
            #expect(block(h, atLineStartingWith: "deep")?.quoteDepth == 2)
            let at = (h.tv.text as NSString).range(of: "nested").location
            let style =
                h.controller.storage.attribute(.paragraphStyle, at: at, effectiveRange: nil)
                as! NSParagraphStyle
            #expect(nested.map { style.headIndent == TextFirstMetrics.listIndent($0) } == true)
        }

        @Test func codeBlocksAndDividersAreDrawnNotTyped() {
            let h = TextFirstHarness("```\ncode line\n```\n\n---\n\nafter")
            #expect(block(h, atLineStartingWith: "code line")?.code == true)
            let divider = (h.tv.text as NSString).range(of: "\u{fffc}").location
            #expect(divider != NSNotFound)
            let b =
                h.controller.storage.attribute(.tfBlock, at: divider, effectiveRange: nil)
                as? TextFirstBlockAttribute
            #expect(b?.divider == true)
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

        // Mason D3: a fully selected list row highlights its rendered marker; a caret or a
        // partial selection does not.
        @Test func aFullySelectedRowHighlightsItsMarker() {
            let h = TextFirstHarness("- alpha beta\n- [ ] gamma\n")
            h.tv.layoutIfNeeded()
            let manager = h.tv.textLayoutManager!
            func markerRects() -> [CGRect?] {
                var out: [CGRect?] = []
                manager.enumerateTextLayoutFragments(
                    from: manager.documentRange.location, options: []
                ) {
                    f in
                    if let f = f as? TextFirstLayoutFragment { out.append(f.highlightedMarkerRect) }
                    return true
                }
                return out
            }
            h.select(0, 0)
            #expect(markerRects().allSatisfy { $0 == nil })
            h.select(2, 6)
            #expect(markerRects().allSatisfy { $0 == nil })
            h.select(0, 11)
            let full = markerRects()
            #expect(full.first.flatMap { $0 } != nil)
            #expect(full.dropFirst().allSatisfy { $0 == nil })
            h.select(0, 17)
            #expect(markerRects().compactMap { $0 }.count == 2)
        }

        @Test func tabAndShiftTabIndentAndOutdentAListItem() {
            let h = TextFirstHarness("- a\n- b\n")
            h.select(3, 3)
            #expect(h.controller.paragraphKey(.tab, onlyIfChanged: true))
            #expect(h.source.hasPrefix("- a\n\t- b"))
            #expect((block(h, atLineStartingWith: "b")?.list?.indent ?? 0) > 0)
            #expect(h.controller.paragraphKey(.shiftTab, onlyIfChanged: true))
            #expect(h.source.hasPrefix("- a\n- b"))
            // Outside a list the key is UIKit's.
            let plain = TextFirstHarness("plain\n")
            plain.select(2, 2)
            #expect(!plain.controller.paragraphKey(.tab, onlyIfChanged: true))
        }

        @Test func enterContinuesAListAndBackspaceLiftsItsMarker() {
            let h = TextFirstHarness("- item\n")
            h.select(4, 4)
            _ = h.tv.delegate?.textView?(
                h.tv, shouldChangeTextIn: h.tv.selectedRange, replacementText: "\n")
            #expect(h.source.hasPrefix("- item\n- "))
            #expect(block(h, atLineStartingWith: "item")?.list?.marker == .bullet)
            #expect(h.controller.divergences.isEmpty)
        }

        /// iOS sim, Fences row 5: after Enter left a code block at the note's end, the empty
        /// last line (where the caret is) was drawn inside the code background. The engine says
        /// that line is no code; TextKit lays it out in the code paragraph's fragment.
        @Test func theEmptyLineAfterACodeBlockIsNotDrawnAsCode() throws {
            let h = TextFirstHarness("```\ncode line\n```\n")
            #expect((h.tv.text as NSString).hasSuffix("\n"))
            #expect(h.controller.trailingBlock == nil)
            h.window.overrideUserInterfaceStyle = .light
            h.tv.layoutIfNeeded()
            let manager = h.tv.textLayoutManager!
            let fragment = try #require(
                manager.textLayoutFragment(for: manager.documentRange.location)
                    as? TextFirstLayoutFragment)
            #expect(fragment.block.code)
            let lines = fragment.textLineFragments
            try #require(lines.count == 2 && lines[1].characterRange.length == 0)
            // The fragment drawn alone, its frame's origin at the image's.
            let size = CGSize(
                width: fragment.containerWidth, height: fragment.layoutFragmentFrame.height)
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            let image = UIGraphicsImageRenderer(size: size, format: format).image { c in
                UIColor.white.setFill()
                c.fill(CGRect(origin: .zero, size: size))
                fragment.draw(
                    at: CGPoint(x: fragment.layoutFragmentFrame.minX, y: 0), in: c.cgContext)
            }
            let cg = image.cgImage!
            var pixels = [UInt8](repeating: 0, count: cg.width * cg.height * 4)
            let context = CGContext(
                data: &pixels, width: cg.width, height: cg.height, bitsPerComponent: 8,
                bytesPerRow: cg.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            context.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
            // Right of any text: grey on the code line, white on the empty line below it.
            func red(_ y: CGFloat) -> Int { Int(pixels[(Int(y) * cg.width + cg.width - 20) * 4]) }
            let code = red(lines[0].typographicBounds.midY)
            let empty = red(lines[1].typographicBounds.midY)
            #expect(code < 250, "code line \(code)")
            #expect(empty >= 250, "empty line \(empty) at \(lines[1].typographicBounds)")
        }

        /// iOS sim, Tags: `#todo` was drawn as plain text. A tag is coloured, nothing else;
        /// inside inline code it is no tag.
        @Test func tagsAreColouredAndStayText() {
            let h = TextFirstHarness("plain #todo and `#no`")
            let text = h.tv.text as NSString
            #expect(text.contains("#todo"))
            let traits = h.tv.traitCollection
            func colour(_ word: String) -> UIColor? {
                (h.controller.storage.attribute(
                    .foregroundColor, at: text.range(of: word).location, effectiveRange: nil)
                    as? UIColor)?.resolvedColor(with: traits)
            }
            let primary = UIColor(Theme.primary).resolvedColor(with: traits)
            #expect(colour("#todo") == primary)
            #expect(colour("odo") == primary)
            #expect(colour("plain") != primary)
            #expect(colour("#no") != primary)
            #expect(h.source == "plain #todo and `#no`")
        }
    }
#endif

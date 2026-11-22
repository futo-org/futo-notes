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

        @Test func aBulletCanBeAddedInsideAQuote() {
            let h = TextFirstHarness("> quoted\n> ")
            let at = (h.tv.text as NSString).range(of: "\n").location + 1
            h.select(at, at)
            h.controller.block(.bulletList)
            h.type("inside")
            #expect(h.source.contains("> - inside"), "\(h.source.debugDescription)")
            #expect(h.block(atLineStartingWith: "inside")?.quoteDepth == 1)
            #expect(h.block(atLineStartingWith: "inside")?.list?.marker == .bullet)
            #expect(h.controller.divergences.isEmpty)
        }

        @Test func listRowsCarryTheirMarkerNumberAndTaskState() {
            let h = TextFirstHarness("- bullet\n\n1. first\n2. second\n\n- [ ] open\n- [x] done\n")
            #expect(h.block(atLineStartingWith: "bullet")?.list?.marker == .bullet)
            #expect(h.block(atLineStartingWith: "second")?.list?.text == "2.")
            #expect(h.block(atLineStartingWith: "open")?.list?.marker == .task)
            #expect(h.block(atLineStartingWith: "open")?.list?.checked == false)
            #expect(h.block(atLineStartingWith: "done")?.list?.checked == true)
            // Each marker is one hidden character before its item's words.
            #expect(h.display.hasPrefix("\u{FFFC}bullet\n"))
        }

        @Test func aLooseListsBlankLineDrawsNoMarker() {
            let h = TextFirstHarness("1. first\n2. second\n\nplain\n\n- [x] done\n\nafter")
            let text = h.tv.text as NSString
            let second = text.range(of: "second").location
            let blank = second + "second".count + 0
            let b =
                h.controller.storage.attribute(.tfBlock, at: blank + 1, effectiveRange: nil)
                as? TextFirstBlockAttribute
            #expect(b == nil || b?.holdsMarkerUnit == false)
            let done = h.block(atLineStartingWith: "done")
            #expect(done?.holdsMarkerUnit == true)
        }

        @Test func nestedListsIndentAndQuotesDrawBars() {
            let h = TextFirstHarness("- a\n  - nested\n\n> > deep\n")
            let nested = h.block(atLineStartingWith: "nested")?.list
            #expect(nested?.indent == 2)
            #expect(h.block(atLineStartingWith: "deep")?.quoteDepth == 2)
            let at = (h.tv.text as NSString).range(of: "nested").location
            let style =
                h.controller.storage.attribute(.paragraphStyle, at: at, effectiveRange: nil)
                as! NSParagraphStyle
            #expect(nested.map { style.headIndent == TextFirstMetrics.listIndent($0) } == true)
            // The first row starts a marker column before the text, at the marker unit.
            #expect(style.firstLineHeadIndent == style.headIndent - TextFirstMetrics.markerStep)
        }

        @Test func equivalentListWhitespaceUsesTheSameNestingGeometry() {
            for whitespace in ["  ", "    ", "\t"] {
                let source = "- root\n\(whitespace)- child\n\(whitespace)\(whitespace)- grandchild"
                let h = TextFirstHarness(source)
                for (word, level) in [("root", 0), ("child", 1), ("grandchild", 2)] {
                    let row = h.block(atLineStartingWith: word)?.list
                    #expect(row?.level == level)
                    #expect(row.map(TextFirstMetrics.listIndent) == 30 + CGFloat(level) * 24)
                }
                #expect(h.source == source)
            }
        }

        @Test func codeBlocksAndDividersAreDrawnNotTyped() {
            let h = TextFirstHarness("```\ncode line\n```\n\n---\n\nafter")
            #expect(h.block(atLineStartingWith: "code line")?.code == true)
            let divider = (h.tv.text as NSString).range(of: "\u{fffc}").location
            #expect(divider != NSNotFound)
            let b =
                h.controller.storage.attribute(.tfBlock, at: divider, effectiveRange: nil)
                as? TextFirstBlockAttribute
            #expect(b?.divider == true)
        }

        @Test func codeLanguageIsDrawnOnceFromTheProjection() {
            let h = TextFirstHarness("```swift\nlet answer = 42\nprint(answer)\n```")
            #expect(h.block(atLineStartingWith: "let answer")?.codeLanguage == "swift")
            #expect(h.block(atLineStartingWith: "print")?.codeLanguage == nil)
            #expect(h.source == "```swift\nlet answer = 42\nprint(answer)\n```")
        }

        @Test func aCodeLanguageHasHeaderSpaceAboveALongFirstLine() {
            let h = TextFirstHarness(
                "```swift\n" + String(repeating: "long code ", count: 30) + "\n```")
            h.tv.layoutIfNeeded()
            let manager = h.tv.textLayoutManager!
            var found = false
            manager.enumerateTextLayoutFragments(
                from: manager.documentRange.location, options: [.ensuresLayout]
            ) { fragment in
                guard let row = fragment as? TextFirstLayoutFragment, row.block.codeLanguage != nil
                else { return true }
                found = true
                #expect(row.topMargin >= 16)
                #expect(row.textLineFragments.first!.typographicBounds.minY >= 16)
                return true
            }
            #expect(found)
        }

        @Test func adjacentCodeBlocksEachDrawTheirLanguage() {
            let h = TextFirstHarness("```swift\nfirst\n```\n```rust\nsecond\nthird\n```")
            #expect(h.block(atLineStartingWith: "first")?.codeLanguage == "swift")
            #expect(h.block(atLineStartingWith: "second")?.codeLanguage == "rust")
            #expect(h.block(atLineStartingWith: "third")?.codeLanguage == nil)
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

        /// A note that is only an empty code block has no character to style; its one empty
        /// line still carries the block, so it is drawn as code when it opens.
        @Test func aNoteThatIsOnlyAnEmptyBlockOpensWithItsLineAsCode() {
            let h = TextFirstHarness("```\n```")
            #expect(h.controller.storage.length == 0)
            #expect(h.controller.trailingBlock?.code == true)
            // As tall as a code line with text, not a thin strip.
            let typed = TextFirstHarness("```\nx\n```")
            // The last line's height: the empty note's is its extra line fragment.
            func height(_ h: TextFirstHarness) -> CGFloat {
                h.tv.layoutIfNeeded()
                let manager = h.tv.textLayoutManager!
                var last: CGFloat = 0
                manager.enumerateTextLayoutFragments(
                    from: manager.documentRange.location,
                    options: [.ensuresLayout, .ensuresExtraLineFragment]
                ) {
                    last = $0.layoutFragmentFrame.height
                    return true
                }
                return last
            }
            #expect(abs(height(h) - height(typed)) <= 1, "\(height(h)) vs \(height(typed))")
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

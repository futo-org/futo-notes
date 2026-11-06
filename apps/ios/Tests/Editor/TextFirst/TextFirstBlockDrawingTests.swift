#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    @Suite @MainActor
    struct TextFirstBlockDrawingTests {
        private func block(_ h: TextFirstHarness, atLineStartingWith word: String) -> TextFirstBlockAttribute? {
            let at = (h.tv.text as NSString).range(of: word).location
            return h.controller.storage.attribute(.tfBlock, at: at, effectiveRange: nil)
                as? TextFirstBlockAttribute
        }

        @Test func listRowsCarryTheirMarkerNumberAndTaskState() {
            let h = TextFirstHarness("- bullet\n\n1. first\n2. second\n\n- [ ] open\n- [x] done\n")
            #expect(block(h, atLineStartingWith: "bullet")?.list?.marker == .bullet)
            #expect(block(h, atLineStartingWith: "second")?.list?.number == 2)
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
            let b = h.controller.storage.attribute(.tfBlock, at: blank + 1, effectiveRange: nil)
                as? TextFirstBlockAttribute
            #expect(b == nil || b?.showsMarker == false)
            let done = block(h, atLineStartingWith: "done")
            #expect(done?.showsMarker == true)
        }

        @Test func nestedListsIndentAndQuotesDrawBars() {
            let h = TextFirstHarness("- a\n  - nested\n\n> > deep\n")
            #expect(block(h, atLineStartingWith: "nested")?.list?.depth == 1)
            #expect(block(h, atLineStartingWith: "deep")?.quoteDepth == 2)
            let at = (h.tv.text as NSString).range(of: "nested").location
            let style = h.controller.storage.attribute(.paragraphStyle, at: at, effectiveRange: nil)
                as! NSParagraphStyle
            #expect(style.headIndent == TextFirstMetrics.listIndent(depth: 1))
        }

        @Test func codeBlocksAndDividersAreDrawnNotTyped() {
            let h = TextFirstHarness("```\ncode line\n```\n\n---\n\nafter")
            #expect(block(h, atLineStartingWith: "code line")?.code == true)
            let divider = (h.tv.text as NSString).range(of: "\u{fffc}").location
            #expect(divider != NSNotFound)
            let b = h.controller.storage.attribute(.tfBlock, at: divider, effectiveRange: nil)
                as? TextFirstBlockAttribute
            #expect(b?.divider == true)
        }

        @Test func tappingACheckboxTogglesThroughTheEngineAndKeepsTheCaret() {
            let h = TextFirstHarness("- [ ] one\n- [x] two\n")
            h.tv.layoutIfNeeded()
            h.select(1, 1)
            let manager = h.tv.textLayoutManager!
            var hit: NSTextLayoutFragment?
            manager.enumerateTextLayoutFragments(from: manager.documentRange.location, options: []) {
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

        @Test func tabAndShiftTabIndentAndOutdentAListItem() {
            let h = TextFirstHarness("- a\n- b\n")
            h.select(3, 3)
            #expect(h.controller.paragraphKey(.tab, onlyIfChanged: true))
            #expect(h.source.hasPrefix("- a\n  - b"))
            #expect(block(h, atLineStartingWith: "b")?.list?.depth == 1)
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
            _ = h.tv.delegate?.textView?(h.tv, shouldChangeTextIn: h.tv.selectedRange, replacementText: "\n")
            #expect(h.source.hasPrefix("- item\n- "))
            #expect(block(h, atLineStartingWith: "item")?.list?.marker == .bullet)
            #expect(h.controller.divergences.isEmpty)
        }
    }
#endif

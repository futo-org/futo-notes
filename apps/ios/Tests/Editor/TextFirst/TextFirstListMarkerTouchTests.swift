#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// A long-press that reports `state` at `point`, as UIKit hands one to its target.
    private final class HeldAt: UILongPressGestureRecognizer {
        private let point: CGPoint
        private let reported: UIGestureRecognizer.State
        init(_ point: CGPoint, in view: UIView, state: UIGestureRecognizer.State) {
            (self.point, reported) = (point, state)
            super.init(target: nil, action: nil)
            view.addGestureRecognizer(self)
        }
        override var state: UIGestureRecognizer.State {
            get { reported }
            set {}
        }
        override func location(in view: UIView?) -> CGPoint { point }
    }

    /// A tap, a hold and a checkbox on a list item's marker unit, through the editor's own touch
    /// handling.
    @Suite @MainActor
    struct TextFirstListMarkerTouchTests {
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
                h.controller.handleMarkerHold(
                    HeldAt(CGPoint(x: unit.midX, y: unit.midY), in: h.tv, state: .began))
                #expect(h.tv.selectedRange == NSRange(location: at, length: 1))
                #expect(h.controller.engineSelection == NSRange(location: at, length: 1))
                #expect(!h.controller.touchHitCheckbox)
                #expect(
                    try h.controller.selectionMarkdown(h.tv.selectedRange)
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
            #expect(
                h.controller.checkboxFragment(at: CGPoint(x: unit.maxX + 4, y: unit.midY)) == nil)
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

        /// A checkbox tap in a focused note: UIKit first moves its caret to the tap and reports it,
        /// then the tap ticks the box and puts the caret back. The engine hears that too, so the
        /// view and the engine keep one selection (seen on the simulator: engine {15,0}, view {9,0}).
        @Test(arguments: [false, true])
        func aCheckboxTapLeavesTheViewAndTheEngineOnOneSelection(boxSelectedByAHold: Bool) {
            let h = TextFirstHarness("- one item here\n- [ ] two\n- three\n")
            let text = h.tv.text as NSString
            let box = text.range(of: "two").location - 1
            let before =
                boxSelectedByAHold
                ? NSRange(location: box, length: 1) : NSRange(location: 9, length: 0)
            h.tv.selectedRange = before
            h.controller.selectionBeforeTouch = before
            // UIKit's own tap handling puts the caret where the finger landed.
            h.select(box + 4, box + 4)
            #expect(h.controller.engineSelection == NSRange(location: box + 4, length: 0))
            h.controller.toggleTask(atLineOffset: box, keeping: h.controller.selectionBeforeTouch)
            #expect(h.source.hasPrefix("- one item here\n- [x] two"))
            #expect(h.tv.selectedRange == before)
            #expect(h.controller.engineSelection == before)
        }
    }
#endif

#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// A tap that reports `.ended` at `point`, as UIKit hands one to its target.
    private final class TappedAt: UITapGestureRecognizer {
        private let point: CGPoint
        init(_ point: CGPoint, in view: UIView) {
            self.point = point
            super.init(target: nil, action: nil)
            view.addGestureRecognizer(self)
        }
        override var state: UIGestureRecognizer.State {
            get { .ended }
            set {}
        }
        override func location(in view: UIView?) -> CGPoint { point }
    }

    /// A code block's fences are hidden and Enter stays in its code, so a tap in the empty space
    /// below a block that ends the note, or above one that starts it, opens a line there.
    @Suite @MainActor
    struct TextFirstCodeBlockEdgeTests {
        /// A tap as UIKit delivers it: the touch comes down, then the tap ends at once.
        private func tap(_ h: TextFirstHarness, at point: CGPoint) {
            h.controller.touchDown(at: point)
            h.controller.handleTap(TappedAt(point, in: h.tv))
        }

        @Test func aTapBelowABlockThatEndsTheNoteOpensALineAfterIt() async {
            let h = TextFirstHarness("```swift\nlet a = 1\n```")
            h.tv.layoutIfNeeded()
            let below = CGPoint(x: 120, y: h.point(line: 0).y + 120)
            let length = h.controller.storage.length
            tap(h, at: below)
            // The new line is the note's last, the caret on it.
            #expect(await h.until { h.controller.storage.length == length + 1 })
            #expect(h.tv.selectedRange == NSRange(location: length + 1, length: 0))
            h.type("after")
            #expect(h.source == "```swift\nlet a = 1\n```\nafter")
        }

        @Test func aTapAboveABlockThatStartsTheNoteOpensALineBeforeIt() async {
            let h = TextFirstHarness("```swift\nlet a = 1\n```\nend")
            h.tv.layoutIfNeeded()
            let above = CGPoint(x: 120, y: h.tv.textContainerInset.top + 2)
            tap(h, at: above)
            #expect(await h.until { h.source.hasPrefix("\n```swift") }, "\(h.source)")
            h.type("before")
            #expect(h.source == "before\n```swift\nlet a = 1\n```\nend")
        }

        @Test func aTapBelowOtherTextOpensNothing() {
            let h = TextFirstHarness("```swift\nlet a = 1\n```\nend")
            h.tv.layoutIfNeeded()
            #expect(h.controller.codeBlockEdge(at: CGPoint(x: 120, y: 600)) == nil)
        }

        /// A tap below the block while the keyboard holds marked text commits it first, as every
        /// other tap-driven command does, so the view and the engine stay one text.
        @Test func aTapBelowTheBlockDuringACompositionCommitsItFirst() async {
            let h = TextFirstHarness("```swift\nlet a = 1\n```")
            h.tv.layoutIfNeeded()
            let end = (h.tv.text as NSString).range(of: "1").upperBound
            h.select(end, end)
            InputDriver(asking: .keyboard).apply(.mark("か"), to: h.tv)
            #expect(h.tv.markedTextRange != nil)
            let below = CGPoint(x: 120, y: h.point(line: 0).y + 120)
            tap(h, at: below)
            #expect(await h.until { h.source.hasSuffix("```\n") || h.source.hasSuffix("```") })
            _ = await h.until(0.3) { false }
            h.type("x")
            #expect(h.source == "```swift\nlet a = 1か\n```\nx", "\(h.source.debugDescription)")
            #expect(h.controller.divergences.isEmpty, "\(h.controller.divergences)")
        }

        /// A commit that changes the display's length (a typed `## ` becomes a hidden heading
        /// prefix) still opens the line after the block, at the block's end after the commit.
        @Test func aTapBelowTheBlockAfterACommitThatShortensTheTextOpensALine() async {
            let h = TextFirstHarness("prose\n```\ncode\n```")
            h.tv.layoutIfNeeded()
            h.select(0, 0)
            InputDriver(asking: .keyboard).apply(.mark("## "), to: h.tv)
            #expect(h.tv.markedTextRange != nil)
            let below = CGPoint(x: 120, y: h.point(line: 0).y + 200)
            tap(h, at: below)
            // The heading prefix is hidden by the commit and the new last line follows the code.
            #expect(await h.until { h.controller.storage.string == "prose\ncode\n" })
            h.type("x")
            #expect(h.source == "## prose\n```\ncode\n```\nx", "\(h.source.debugDescription)")
            #expect(h.controller.divergences.isEmpty, "\(h.controller.divergences)")
        }

        /// A note that is only an empty fenced block shows no characters; a tap below it still
        /// opens a line after it.
        @Test func aTapBelowANoteThatIsOnlyAnEmptyBlockOpensALine() async {
            let h = TextFirstHarness("```\n```")
            h.tv.layoutIfNeeded()
            let below = CGPoint(x: 120, y: h.tv.textContainerInset.top + 200)
            tap(h, at: below)
            _ = await h.until(0.5) { false }
            h.type("x")
            #expect(h.source == "```\n```\nx", "\(h.source.debugDescription)")
        }

        /// Only a tap opens the line: a press held as long as a hold, then lifted, changes nothing.
        @Test func aHoldBelowTheBlockOpensNothing() async {
            let h = TextFirstHarness("```go\nfunc main() {\nunclosed")
            h.tv.layoutIfNeeded()
            let below = CGPoint(x: 120, y: h.point(line: 0).y + 160)
            h.controller.touchDown(at: below)
            h.controller.touchDownTime -= 0.9
            h.controller.handleTap(TappedAt(below, in: h.tv))
            _ = await h.until(0.5) { false }
            #expect(h.source == "```go\nfunc main() {\nunclosed", "\(h.source.debugDescription)")
        }
    }
#endif

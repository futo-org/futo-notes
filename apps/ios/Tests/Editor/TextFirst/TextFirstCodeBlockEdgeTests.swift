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
        @Test func aTapBelowABlockThatEndsTheNoteOpensALineAfterIt() async {
            let h = TextFirstHarness("```swift\nlet a = 1\n```")
            h.tv.layoutIfNeeded()
            let below = CGPoint(x: 120, y: h.point(line: 0).y + 120)
            let length = h.controller.storage.length
            h.controller.handleTap(TappedAt(below, in: h.tv))
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
            h.controller.handleTap(TappedAt(above, in: h.tv))
            #expect(await h.until { h.source.hasPrefix("\n```swift") }, "\(h.source)")
            h.type("before")
            #expect(h.source == "before\n```swift\nlet a = 1\n```\nend")
        }

        @Test func aTapBelowOtherTextOpensNothing() {
            let h = TextFirstHarness("```swift\nlet a = 1\n```\nend")
            h.tv.layoutIfNeeded()
            #expect(h.controller.codeBlockEdge(at: CGPoint(x: 120, y: 600)) == nil)
        }
    }
#endif

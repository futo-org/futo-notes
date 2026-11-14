#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    @Suite @MainActor
    struct TextFirstImageBoundaryTests {
        /// A system text service can replace a range without first selecting it. Even when
        /// that range cuts through hidden image Markdown, the engine removes the whole image
        /// and the host adopts its corrected display rather than leaving source fragments.
        @Test func aTextServiceReplacementCannotSplitAnImage() {
            for asking in Asking.allCases {
                let h = TextFirstHarness("x ![i](p) y")
                InputDriver(asking: asking).apply(.replace(5, 11, "Q"), to: h.tv)
                #expect(h.source == "x Q")
                #expect(h.display == "x Q")
                #expect(h.controller.divergences.isEmpty)
                h.controller.undo()
                #expect(h.source == "x ![i](p) y")
            }
        }

        @Test func caretStopsAreOnlyAtAnImagesEnds() {
            let h = TextFirstHarness("a ![x](p.png) b\n")
            // The image is characters 2..<13.
            h.select(5, 5)
            #expect(h.tv.selectedRange == NSRange(location: 2, length: 0))
            h.select(11, 11)
            #expect(h.tv.selectedRange == NSRange(location: 13, length: 0))
            // One step in from an end (an arrow key) crosses the whole image.
            h.select(2, 2)
            h.tv.selectedRange = NSRange(location: 3, length: 0)
            #expect(h.tv.selectedRange == NSRange(location: 13, length: 0))
            h.tv.selectedRange = NSRange(location: 12, length: 0)
            #expect(h.tv.selectedRange == NSRange(location: 2, length: 0))
            // A range ending inside the image ends at its nearer end.
            h.select(0, 4)
            #expect(h.tv.selectedRange == NSRange(location: 0, length: 2))
            h.select(0, 11)
            #expect(h.tv.selectedRange == NSRange(location: 0, length: 13))
        }

    }
#endif

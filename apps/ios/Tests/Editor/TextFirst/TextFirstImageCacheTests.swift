#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// The decoded-image cache is shared by every editor in the process.
    @Suite @MainActor
    struct TextFirstImageCacheTests {
        private func atom(_ h: TextFirstHarness) -> TextFirstImageAtom? {
            var found: TextFirstImageAtom?
            let all = NSRange(location: 0, length: h.controller.storage.length)
            h.controller.storage.enumerateAttribute(.tfImage, in: all) { v, _, stop in
                if let span = v as? TextFirstImageSpan {
                    found = span.atom
                    stop.pointee = true
                }
            }
            return found
        }

        /// Another vault's file of the same name, or this file replaced, is decoded from its own
        /// bytes, never shown from the cache.
        @Test func aSameNamedOrReplacedFileIsNotShownFromTheCache() async throws {
            let wide = TextFirstHarness(
                "![](p.png)\n", files: ["p.png": TextFirstHarness.png(1000, 500)])
            #expect(await wide.until { self.atom(wide)?.image != nil })
            let small = TextFirstHarness(
                "![](p.png)\n", files: ["p.png": TextFirstHarness.png(200, 100)])
            #expect(await small.until { self.atom(small)?.image != nil })
            #expect(atom(small)?.naturalPixelWidth == 200)

            _ = await wide.controller.close()
            // A later modification date, as a sync or a re-import writes.
            try await Task.sleep(nanoseconds: 1_100_000_000)
            try TextFirstHarness.png(300, 150).write(to: wide.root.appendingPathComponent("p.png"))
            let again = try wide.reopen()
            #expect(await again.until { self.atom(again)?.image != nil })
            #expect(atom(again)?.naturalPixelWidth == 300)
        }

        /// A bitmap reused from the cache still knows its file is larger, so a wider view (a
        /// rotation) decodes it again.
        @Test func aCachedBitmapIsDecodedAgainForAWiderView() async throws {
            let h = TextFirstHarness(
                "![](big.png)\n", files: ["big.png": TextFirstHarness.png(4000, 2000)])
            #expect(await h.until { self.atom(h)?.image != nil })
            _ = await h.controller.close()
            let again = try h.reopen()
            // The reopened editor gets the bitmap from the cache (the harness styles before its
            // view has a width, so through the loader's cache rather than at the atom's creation).
            #expect(await again.until { self.atom(again)?.image != nil })
            let first = try #require(atom(again))
            #expect(first.naturalPixelWidth == 4000)
            let before = first.decodedPixelWidth
            again.window.frame.size.width = 1000
            again.tv.frame = again.window.bounds
            again.tv.layoutIfNeeded()
            #expect(await again.until { (self.atom(again)?.decodedPixelWidth ?? 0) > before })
        }
    }
#endif

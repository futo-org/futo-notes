#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// An image's height is a baseline lift on its own glyph, so only its line is tall. UIKit sizes
    /// carets, selection rects and handles to that line, which put photo-tall bars on every position
    /// of an image's line; every image was drawn from the line's top instead of from the baseline;
    /// and a selected image's tint was drawn under the bitmap.
    @Suite @MainActor
    struct TextFirstImageLineTests {
        static let text = ceil(TextFirstEditorController.bodyFont.lineHeight)

        /// The editor with every image loaded, and each image's drawn frame (text view coordinates).
        private func open(_ source: String, _ files: [String: (Int, Int)]) async -> (
            TextFirstHarness, [CGRect]
        ) {
            let h = TextFirstHarness(
                source, files: files.mapValues { TextFirstHarness.png($0.0, $0.1) })
            _ = await h.until {
                var at = 0
                while at < h.controller.storage.length {
                    var run = NSRange()
                    let v = h.controller.storage.attribute(
                        .tfImage, at: at, longestEffectiveRange: &run,
                        in: NSRange(
                            location: at, length: h.controller.storage.length - at))
                    if let span = v as? TextFirstImageSpan, span.atom.image == nil { return false }
                    at = NSMaxRange(run)
                }
                return true
            }
            try? await Task.sleep(nanoseconds: 200_000_000)
            h.tv.layoutIfNeeded()
            return (h, frames(h))
        }

        private func fragment(_ h: TextFirstHarness, at offset: Int = 0) -> TextFirstLayoutFragment
        {
            let manager = h.tv.textLayoutManager!
            let at = manager.location(manager.documentRange.location, offsetBy: offset)!
            return manager.textLayoutFragment(for: at) as! TextFirstLayoutFragment
        }

        private func frames(_ h: TextFirstHarness) -> [CGRect] {
            let f = fragment(h)
            let inset = h.tv.textContainerInset
            return f.imageRuns.map {
                f.imageRect($0)!.offsetBy(
                    dx: inset.left, dy: inset.top + f.layoutFragmentFrame.minY)
            }
        }

        private func caret(_ h: TextFirstHarness, _ offset: Int) -> CGRect {
            h.tv.caretRect(for: h.tv.position(from: h.tv.beginningOfDocument, offset: offset)!)
        }

        private func offsets(of needle: String, in h: TextFirstHarness) -> NSRange {
            ((h.tv.text ?? "") as NSString).range(of: needle)
        }

        @Test func everyCaretOnAnImageLineIsAsTallAsText() async {
            let (h, frames) = await open("hello ![](line-a.png) world", ["line-a.png": (180, 120)])
            let image = offsets(of: "![](line-a.png)", in: h)
            let last = (h.tv.text! as NSString).length - 1
            let positions = [
                0, 3, 6, image.location, NSMaxRange(image), NSMaxRange(image) + 3, last,
            ]
            for p in positions {
                let rect = caret(h, p)
                #expect(rect.height <= Self.text + 1, "offset \(p): \(rect)")
                // Level with the text: the caret's bottom is no lower than the baseline's descent.
                #expect(
                    rect.maxY >= frames[0].maxY - 1 && rect.maxY <= frames[0].maxY + Self.text / 3,
                    "offset \(p): \(rect) vs \(frames[0])")
            }
        }

        @Test func selectionRectsAndHandlesStartingAtThePhotoAreTextHeight() async {
            let (h, frames) = await open("hello ![](line-a.png) world", ["line-a.png": (180, 120)])
            let image = offsets(of: "![](line-a.png)", in: h)
            h.select(image.location, NSMaxRange(image) + 3)
            h.tv.layoutIfNeeded()
            let rects = h.tv.selectionRects(for: h.tv.selectedTextRange!)
            #expect(!rects.isEmpty)
            for r in rects {
                #expect(r.rect.height <= Self.text + 1, "\(r.rect)")
                #expect(r.rect.maxY >= frames[0].maxY - 1, "\(r.rect) vs \(frames[0])")
            }
            let start = rects.first(where: \.containsStart)
            #expect(start != nil && start!.rect.height <= Self.text + 1)
            let whole = rects.reduce(CGRect.null) { $0.union($1.rect) }
            #expect(whole.minX <= frames[0].minX + 2 && whole.width >= frames[0].width * 0.9)
        }

        @Test func aShorterImageBesideATallerOneSitsOnTheBaseline() async {
            let (h, frames) = await open(
                "a ![](line-s.png) and ![](line-t.png) b",
                ["line-s.png": (40, 13), "line-t.png": (100, 80)])
            #expect(frames.count == 2)
            #expect(abs(frames[0].maxY - frames[1].maxY) <= 1, "\(frames)")
            #expect(frames[0].minY > frames[1].minY + 20, "\(frames)")
            let small = offsets(of: "![](line-s.png)", in: h)
            let after = caret(h, NSMaxRange(small))
            #expect(after.height <= Self.text + 1, "\(after)")
            #expect(
                after.maxY >= frames[0].maxY - 1 && after.maxY <= frames[0].maxY + Self.text / 3)
            #expect(abs(after.minX - frames[0].maxX) <= 2, "\(after) vs \(frames[0])")
        }

        @Test func aSelectedImageIsTintedOverTheBitmap() async throws {
            let (h, frames) = await open("![](line-a.png)", ["line-a.png": (120, 80)])
            let f = fragment(h)
            let inset = h.tv.textContainerInset
            let local = try #require(f.imageRect(f.imageRuns[0]))
            _ = frames
            func blue(_ f: TextFirstLayoutFragment) -> CGFloat {
                let size = CGSize(width: 400, height: 200)
                let format = UIGraphicsImageRendererFormat()
                format.scale = 1
                let picture = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
                    f.draw(at: .zero, in: ctx.cgContext)
                }
                var pixel = [UInt8](repeating: 0, count: 4)
                let space = CGColorSpaceCreateDeviceRGB()
                let context = CGContext(
                    data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                    space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
                let all = CGRect(
                    x: -local.midX, y: -(size.height - local.midY), width: size.width,
                    height: size.height)
                context.draw(picture.cgImage!, in: all)
                return CGFloat(pixel[2])
            }
            _ = inset
            let plain = blue(f)
            let range = offsets(of: "![](line-a.png)", in: h)
            h.tv.selectedRange = range
            h.tv.layoutIfNeeded()
            let selected = blue(fragment(h))
            #expect(selected > plain + 20, "blue \(plain) -> \(selected)")
        }
    }
#endif

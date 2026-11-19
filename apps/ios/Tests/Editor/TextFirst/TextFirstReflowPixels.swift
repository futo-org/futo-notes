#if DEBUG
    import Foundation
    import UIKit

    @testable import FutoNotesNative

    /// Pixels for the block drag preview's tests: the note as the editor draws it, a layer
    /// tree drawn, and comparisons of the two.
    extension TextFirstBlockReflowTests {
        /// The note on screen as the editor draws it (the test host cannot capture its real
        /// screen; the UI tests compare the preview with real screenshots).
        static func screen(_ h: TextFirstHarness) -> CGImage {
            h.tv.layoutIfNeeded()
            let drawn = TextFirstSlicePainter(textView: h.tv).paint(h.tv.bounds)!
            let layer = CALayer()
            layer.frame = CGRect(origin: .zero, size: h.tv.bounds.size)
            layer.contents = drawn
            layer.contentsGravity = .topLeft
            layer.contentsScale = h.tv.traitCollection.displayScale
            return image(layer, h)
        }

        /// `layer` drawn as its model tree stands (no animation in flight), the text view's
        /// size at the screen's scale.
        static func image(_ layer: CALayer, _ h: TextFirstHarness, over: UIColor? = nil) -> CGImage
        {
            h.tv.layoutIfNeeded()
            let format = UIGraphicsImageRendererFormat(for: h.tv.traitCollection)
            format.opaque = true
            return UIGraphicsImageRenderer(size: h.tv.bounds.size, format: format).image { ui in
                if let over {
                    over.setFill()
                    ui.cgContext.fill(CGRect(origin: .zero, size: h.tv.bounds.size))
                }
                h.tv.traitCollection.performAsCurrent { layer.render(in: ui.cgContext) }
            }.cgImage!
        }

        /// When a comparison fails: both images, kept where the run's log names them.
        static func keep(_ a: CGImage, _ b: CGImage, _ name: String) -> String {
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("reflow")
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            for (image, side) in [(a, "a"), (b, "b")] {
                try? UIImage(cgImage: image).pngData()?.write(
                    to: dir.appendingPathComponent("\(name)-\(side).png"))
            }
            return dir.path
        }

        /// The box of an image's ink (dark pixels) in `rows` (points from the top), in pixels:
        /// top, bottom, left, right.
        static func ink(_ image: CGImage, rows: Range<CGFloat>, scale: CGFloat? = nil) -> [Int] {
            let p = bytes(image)
            let scale = scale ?? CGFloat(image.width) / UIScreen.main.bounds.width
            var box = [Int.max, -1, Int.max, -1]
            for r in max(
                0, Int(rows.lowerBound * scale))..<min(image.height, Int(rows.upperBound * scale))
            {
                for c in 0..<image.width where p[(r * image.width + c) * 4] < 100 {
                    box = [min(box[0], r), max(box[1], r), min(box[2], c), max(box[3], c)]
                }
            }
            return box
        }

        /// How many pixels of two same-sized images differ by more than `threshold` in a channel,
        /// in all rows or `rows` (points from the top).
        static func differing(
            _ a: CGImage, _ b: CGImage, rows: Range<CGFloat>? = nil, threshold: Int = 24
        ) -> Int {
            let (pa, pb) = (bytes(a), bytes(b))
            guard pa.count == pb.count else { return Int.max }
            let scale = CGFloat(a.width) / UIScreen.main.bounds.width
            let row = a.width * 4
            let from = rows.map { max(0, Int($0.lowerBound * scale)) * row } ?? 0
            let to = rows.map { min(a.height, Int($0.upperBound * scale)) * row } ?? pa.count
            var count = 0
            for i in stride(from: from, to: max(from, to), by: 4) {
                for c in 0..<3 where abs(Int(pa[i + c]) - Int(pb[i + c])) > threshold {
                    count += 1
                    break
                }
            }
            return count
        }

        fileprivate static func bytes(_ image: CGImage) -> [UInt8] {
            var out = [UInt8](repeating: 0, count: image.width * image.height * 4)
            out.withUnsafeMutableBytes { raw in
                let context = CGContext(
                    data: raw.baseAddress, width: image.width, height: image.height,
                    bitsPerComponent: 8, bytesPerRow: image.width * 4,
                    space: CGColorSpace(name: CGColorSpace.sRGB)!,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
                context?.draw(
                    image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            }
            return out
        }
    }
#endif

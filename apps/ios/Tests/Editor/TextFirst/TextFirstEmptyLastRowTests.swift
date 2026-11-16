#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// The note's empty last line is drawn on its own row when the line above it is empty too.
    @Suite @MainActor
    struct TextFirstEmptyLastRowTests {
        /// Backspacing the task above an empty last task down to nothing leaves two empty tasks,
        /// each drawing its one box on its own row (TextKit lays the last one out inside the row
        /// above, at the default font's height).
        @Test func emptyingTheTaskAboveAnEmptyLastTaskDrawsEachBoxOnItsRow() async throws {
            let h = TextFirstHarness("- [ ] milk\n- [ ] eggs\n- [ ] bread\n- [ ] ")
            h.window.overrideUserInterfaceStyle = .light  // the ink scan reads dark strokes
            let end = (h.tv.text as NSString).range(of: "bread").upperBound
            h.select(end, end)
            for _ in 0..<5 { h.tv.deleteBackward() }
            #expect(h.source == "- [ ] milk\n- [ ] eggs\n- [ ] \n- [ ] ")
            _ = await h.until(0.5) { false }
            let boxes = gutterBands(h)
            try #require(boxes.count == 4, "\(boxes)")
            // One box each (two overlapping read as one taller band), a row apart.
            let heights = boxes.map(\.height)
            #expect(heights.max()! - heights.min()! < 0.5, "boxes overlap: \(boxes)")
            let pitches = zip(boxes, boxes.dropFirst()).map { $1.midY - $0.midY }
            #expect(pitches.max()! - pitches.min()! < 0.5, "uneven rows: \(boxes)")
            #expect(h.controller.divergences.isEmpty)
        }

        /// The bands of ink in the marker gutter (left of the list text), top to bottom, in
        /// points: one per drawn marker.
        private func gutterBands(_ h: TextFirstHarness) -> [CGRect] {
            h.tv.tintColor = .clear  // the caret is ink too
            h.tv.layoutIfNeeded()
            let position = h.tv.position(from: h.tv.beginningOfDocument, offset: 0)!
            let textX = h.tv.caretRect(for: position).minX
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
            let xs = 0..<Int((textX - 2) * scale)
            func inked(_ y: Int) -> Bool {
                xs.contains { x in
                    let i = (y * cg.width + x) * 4
                    return Int(pixels[i]) + Int(pixels[i + 1]) + Int(pixels[i + 2]) < 3 * 200
                }
            }
            var bands: [CGRect] = []
            var open: Int?
            for y in 0...cg.height {
                let ink = y < cg.height && inked(y)
                if ink, open == nil { open = y }
                if !ink, let from = open {
                    bands.append(
                        CGRect(
                            x: 0, y: CGFloat(from) / scale, width: 0,
                            height: CGFloat(y - from) / scale))
                    open = nil
                }
            }
            return bands
        }
    }
#endif

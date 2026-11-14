import CoreText
import UIKit

// List marker geometry and drawing, shared by paragraph rows and the empty last line.
extension TextFirstLayoutFragment {
    /// Where a bullet or box is centered: the middle of the row's capital letters.
    private func markerCenterY(_ row: Row) -> CGFloat { row.baseline - row.font.capHeight / 2 }

    /// The leading edge of the list text, in container coordinates.
    func textIndent(of block: TextFirstBlockAttribute) -> CGFloat {
        guard block.list != nil else { return 0 }
        return TextFirstMetrics.quoteIndent(depth: block.quoteDepth) + block.listIndent
    }

    func checkboxRect(of block: TextFirstBlockAttribute, row: Row) -> CGRect? {
        guard let list = block.list, block.showsMarker, list.marker == .task else { return nil }
        let side = TextFirstMetrics.checkboxSide
        return CGRect(
            x: textIndent(of: block) - side - 8, y: markerCenterY(row) - side / 2, width: side,
            height: side)
    }

    func drawListMarker(
        _ list: TextFirstListRow,
        of block: TextFirstBlockAttribute, row: Row, at point: CGPoint, in context: CGContext
    ) {
        switch list.marker {
        case .task:
            guard let box = checkboxRect(of: block, row: row) else { return }
            let r = box.offsetBy(dx: point.x, dy: point.y)
            let path = UIBezierPath(roundedRect: r, cornerRadius: 4)
            context.saveGState()
            if list.checked {
                accent.setFill()
                path.fill()
                UIColor.white.setStroke()
                let tick = UIBezierPath()
                tick.move(to: CGPoint(x: r.minX + 4.5, y: r.midY + 0.5))
                tick.addLine(to: CGPoint(x: r.minX + 7.7, y: r.maxY - 5))
                tick.addLine(to: CGPoint(x: r.maxX - 4, y: r.minY + 5))
                tick.lineWidth = 2
                tick.lineCapStyle = .round
                tick.lineJoinStyle = .round
                tick.stroke()
            } else {
                UIColor.secondaryLabel.setStroke()
                path.lineWidth = 1.5
                path.stroke()
            }
            context.restoreGState()
        case .ordered:
            let font = UIFont.monospacedDigitSystemFont(ofSize: 17, weight: .regular)
            let text = NSAttributedString(
                string: list.text,
                attributes: [.font: font, .foregroundColor: UIColor.secondaryLabel])
            let size = text.size()
            // Each TextKit fragment has its own raster backing. Fill glyph outlines as
            // vector art so its local text-raster phase cannot move the number when the
            // empty extra line becomes a paragraph of its own.
            let ctFont = font as CTFont
            let characters = Array(list.text.utf16)
            var glyphs = [CGGlyph](repeating: 0, count: characters.count)
            CTFontGetGlyphsForCharacters(ctFont, characters, &glyphs, characters.count)
            var advances = [CGSize](repeating: .zero, count: glyphs.count)
            CTFontGetAdvancesForGlyphs(ctFont, .horizontal, glyphs, &advances, glyphs.count)
            context.saveGState()
            context.translateBy(
                x: point.x + textIndent(of: block) - size.width - 6,
                y: point.y + row.baseline)
            context.scaleBy(x: 1, y: -1)
            UIColor.secondaryLabel.setFill()
            for (glyph, advance) in zip(glyphs, advances) {
                if let path = CTFontCreatePathForGlyph(ctFont, glyph, nil) {
                    context.addPath(path)
                    context.fillPath()
                }
                context.translateBy(x: advance.width, y: 0)
            }
            context.restoreGState()
        case .bullet:
            let d: CGFloat = 6
            let r = CGRect(
                x: point.x + textIndent(of: block) - 14 - d / 2,
                y: point.y + markerCenterY(row) - d / 2,
                width: d, height: d)
            switch list.level % 3 {
            case 1:
                UIColor.secondaryLabel.setStroke()
                context.setLineWidth(1.2)
                context.strokeEllipse(in: r.insetBy(dx: 0.6, dy: 0.6))
            case 2:
                UIColor.secondaryLabel.setFill()
                context.fill(r)
            default:
                UIColor.secondaryLabel.setFill()
                context.fillEllipse(in: r)
            }
        case .plain:
            break
        }
    }
}

import CoreText
import UIKit

// A list item's bullet, number or checkbox, drawn over its marker unit: the hidden U+FFFC the
// engine puts at the item's start, typeset one marker column wide (`TextFirstTypesetDelegate`). The
// marker is drawn where TextKit laid that character out, beside the text on whichever side the
// paragraph reads from, so it is drawn once and the caret, selection and taps meet it as the
// one character it is.
extension TextFirstLayoutFragment {
    /// The marker unit as laid out: its rect (x in container coordinates, y relative to the
    /// fragment) and whether the item's text is on its left (a right-to-left item). Nil when
    /// the paragraph does not start with one.
    var markerUnit: (rect: CGRect, rightToLeft: Bool)? {
        guard let paragraph = textElement as? NSTextParagraph,
            paragraph.attributedString.length > 0,
            paragraph.attributedString.attribute(.tfListMarker, at: 0, effectiveRange: nil)
                != nil,
            let line = textLineFragments.first, line.characterRange.length > 0
        else { return nil }
        let bounds = line.typographicBounds
        // The unit's leading edge, and which side the text is on. Its far edge is not read from
        // character 1: in a right-to-left item that starts with digits (`123 שלום`), character
        // 1's edge is the far side of the digits' run.
        let start = line.locationForCharacter(at: 0).x
        let rightToLeft = line.locationForCharacter(at: 1).x < start
        let width = block.markerColumn
        return (
            CGRect(
                x: layoutFragmentFrame.minX + bounds.minX + (rightToLeft ? start - width : start),
                y: bounds.minY, width: width, height: bounds.height),
            rightToLeft
        )
    }

    /// The checkbox's rect: x in container coordinates, y relative to the fragment.
    var checkboxRect: CGRect? {
        guard block.list?.marker == .task, let unit = markerUnit else { return nil }
        return checkboxRect(unit, row: ownRow)
    }

    /// Where a bullet or box is centered: the middle of the row's capital letters.
    private func markerCenterY(_ row: Row) -> CGFloat { row.baseline - row.font.capHeight / 2 }

    /// The x a marker part `distance` points from the unit's text side lies at, into the unit.
    private func fromTextSide(
        _ unit: (rect: CGRect, rightToLeft: Bool), _ distance: CGFloat
    ) -> CGFloat {
        unit.rightToLeft ? unit.rect.minX + distance : unit.rect.maxX - distance
    }

    private func checkboxRect(_ unit: (rect: CGRect, rightToLeft: Bool), row: Row) -> CGRect {
        let side = TextFirstMetrics.checkboxSide
        let x = fromTextSide(unit, 8)
        return CGRect(
            x: unit.rightToLeft ? x : x - side, y: markerCenterY(row) - side / 2, width: side,
            height: side)
    }

    func drawListMarker(at point: CGPoint, in context: CGContext) {
        guard let list = block.list, let unit = markerUnit else { return }
        let row = ownRow
        switch list.marker {
        case .task:
            let r = checkboxRect(unit, row: row).offsetBy(dx: point.x, dy: point.y)
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
            let font = TextFirstMetrics.numberFont
            let width = NSAttributedString(string: list.text, attributes: [.font: font])
                .size().width
            let x = fromTextSide(unit, TextFirstMetrics.numberGap)
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
                x: point.x + (unit.rightToLeft ? x : x - width), y: point.y + row.baseline)
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
                x: point.x + fromTextSide(unit, 14) - d / 2,
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

import UIKit

// The card a lifted block rides on, as the retired web editor drew it: about 4% larger than the
// block, 14 pt corners, the surface colour at 80% behind the block's opaque drawing, a hairline
// border, three shadows, and at most 40% of the screen tall with the last 56 pt of the block
// faded out. Unlike the web editor's, a capped card is placed so the finger is on it and it
// stays on screen, the enlarged card keeps clear of the screen's sides, and the fade takes only
// the block's drawing, never the card or its shadow.

enum TextFirstBlockCard {
    static let enlarged: CGFloat = 1.04
    static let corner: CGFloat = 14
    /// Around the block: beside it (where the screen allows) and above and below it.
    static let side: CGFloat = 12
    static let pad: CGFloat = 10
    /// The tallest a card may be, as a share of the screen's height, and how much of a capped
    /// block's drawing fades out at its foot.
    static let tallest: CGFloat = 0.4
    static let fade: CGFloat = 56
    /// The enlarged card's least distance from the screen's sides and from what shows.
    static let margin: CGFloat = 8
    /// [offset y, blur, opacity] of each shadow, deepest last.
    static let shadows: [(y: CGFloat, blur: CGFloat, alpha: Float)] = [
        (1, 2, 0.12), (6, 14, 0.16), (20, 44, 0.24),
    ]

    /// Where a card for `block` (text view coordinates: what it shows of the block) sits at the
    /// lift, unscaled: over the block with room around it, no wider than keeps the enlarged
    /// card `margin` from the sides of `shown`, no taller than `tallest` of `screen`; moved, when
    /// that leaves the finger at `finger` off it, so the finger is 40% of the way down it; and
    /// kept inside `shown` when it fits.
    static func frame(
        for block: CGRect, finger: CGPoint, shown: CGRect, screen: CGFloat
    ) -> CGRect {
        let widest = (shown.width - 2 * margin) / enlarged
        let width = min(block.width + 2 * side, widest)
        let height = min(block.height + 2 * pad, screen * tallest)
        var frame = CGRect(
            x: block.midX - width / 2, y: block.minY - pad, width: width, height: height)
        let reach = (enlarged - 1) / 2
        frame.origin.x = min(
            max(frame.minX, shown.minX + margin + width * reach),
            shown.maxX - margin - width * (1 + reach))
        if !(frame.minY...frame.maxY ~= finger.y) {
            frame.origin.y = finger.y - height * 0.4
        }
        if height + 2 * margin <= shown.height {
            frame.origin.y = min(
                max(frame.minY, shown.minY + margin + height * reach),
                shown.maxY - margin - height * (1 + reach))
        }
        return frame
    }

    /// A card at `frame` showing `content` (the block's drawing, `block` big, over nothing) as
    /// the block was laid out: its drawing sits where the block was relative to the card.
    @MainActor
    static func make(
        _ content: CGImage?, of block: CGRect, at frame: CGRect, surface: UIColor, scale: CGFloat
    ) -> UIView {
        let card = UIView(frame: frame)
        card.isUserInteractionEnabled = false
        let bounds = card.bounds
        let outline = UIBezierPath(roundedRect: bounds, cornerRadius: corner).cgPath
        for shadow in shadows {
            let layer = CALayer()
            layer.frame = bounds
            layer.shadowPath = outline
            layer.shadowColor = UIColor.black.cgColor
            layer.shadowOpacity = shadow.alpha
            layer.shadowRadius = shadow.blur / 2
            layer.shadowOffset = CGSize(width: 0, height: shadow.y)
            // Only outside the card: under its see-through background a shadow would darken it.
            let outside = CAShapeLayer()
            let room = bounds.insetBy(dx: -3 * shadow.blur, dy: -3 * shadow.blur - shadow.y)
            let path = UIBezierPath(rect: room)
            path.append(UIBezierPath(roundedRect: bounds, cornerRadius: corner))
            outside.path = path.cgPath
            outside.fillRule = .evenOdd
            layer.mask = outside
            card.layer.addSublayer(layer)
        }
        let body = UIView(frame: bounds)
        body.backgroundColor = surface.withAlphaComponent(0.8)
        body.layer.cornerRadius = corner
        body.layer.cornerCurve = .continuous
        body.layer.borderWidth = 1 / scale
        body.layer.borderColor = UIColor.separator.cgColor
        body.clipsToBounds = true
        let drawing = CALayer()
        drawing.contents = content
        drawing.contentsScale = scale
        drawing.contentsGravity = .topLeft
        // Exactly as big as the drawing (a capped block's is only what the card shows): a layer
        // taller than its contents pins them to its foot on iOS, out of the card.
        let drawn = content.map { CGFloat($0.height) / scale } ?? block.height
        drawing.frame = CGRect(
            x: block.minX - frame.minX, y: pad, width: block.width, height: drawn)
        if block.height + 2 * pad > frame.height {
            // The foot of a capped block's drawing fades into the card.
            let fade = CAGradientLayer()
            fade.frame = drawing.bounds
            let end = min(1, (frame.height - pad) / drawn)
            let start = max(0, end - Self.fade / drawn)
            fade.colors = [UIColor.black.cgColor, UIColor.black.cgColor, UIColor.clear.cgColor]
            fade.locations = [0, NSNumber(value: Double(start)), NSNumber(value: Double(end))]
            drawing.mask = fade
        }
        body.layer.addSublayer(drawing)
        card.addSubview(body)
        return card
    }

    /// The lift: the card grows from 97% to its size and fades in over 120 ms.
    @MainActor
    static func lift(_ card: UIView) {
        card.alpha = 0
        card.transform = CGAffineTransform(scaleX: 0.97, y: 0.97)
        let animator = UIViewPropertyAnimator(
            duration: 0.12,
            timingParameters: UICubicTimingParameters(
                controlPoint1: CGPoint(x: 0.2, y: 0.9), controlPoint2: CGPoint(x: 0.3, y: 1)))
        animator.addAnimations {
            card.alpha = 1
            card.transform = CGAffineTransform(scaleX: enlarged, y: enlarged)
        }
        animator.startAnimation()
    }
}

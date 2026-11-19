import UIKit

// The live preview's side of a drop (#448, #449): the copy turns solid, the screen may move
// under the curtain to hold what shows still, and each slice and the copy slide from where they
// are drawn to where the moved note draws them.

extension TextFirstReflow {
    /// The release: the copy is drawn solid at once.
    func solidify() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        copy.opacity = 1
        CATransaction.commit()
    }

    /// The move is in the note under the curtain: slide each run, and the copy, from where it
    /// is drawn to where the note now draws it (`runs`, `block`: text view coordinates), drawn
    /// from the note itself where it is `drawable` (laid out). A layer whose new drawing starts
    /// elsewhere in its run moves by as much first, so its text slides from where it is drawn.
    /// The copy's drawing fades into the block's as it arrives (a box or indent it gained on
    /// arrival comes in, not pops). Everything is drawn first; the slides then take `duration`,
    /// or what is left of it before `deadline` once the drawing is done, and none at all when
    /// that is under a third of it.
    func settle(
        runs: [CGRect], block: CGRect?, drawable: CGRect, over duration: CFTimeInterval,
        by deadline: CFTimeInterval = .infinity
    ) {
        builder = nil
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        // What is drawn beyond a margin around the screen cannot slide into view.
        let reach = visible.insetBy(dx: 0, dy: -visible.height / 4).intersection(drawable)
        var targets: [(CALayer, CGPoint)] = []
        for (j, frame) in runs.enumerated() where j < slices.count {
            let layer = slices[j].layer
            let shown = frame.intersection(reach)
            guard !shown.isNull, shown.height > 0 else {
                layer.isHidden = true
                continue
            }
            show(draw(shown, layingOut: false), in: layer)
            slides.shift(layer, by: shown.minY - frame.minY - slices[j].shown)
            slices[j].shown = shown.minY - frame.minY
            targets.append((layer, inCurtain(shown)))
        }
        var before: Any?
        if let frame = block, !frame.intersection(reach).isNull {
            let shown = frame.intersection(reach)
            before = copy.contents
            show(draw(shown, layingOut: false), in: copy)
            slides.shift(copy, by: shown.minY - frame.minY - copyShown)
            copyShown = shown.minY - frame.minY
            targets.append((copy, inCurtain(shown)))
        }
        let left = min(duration, deadline - CACurrentMediaTime())
        let time = left >= duration / 3 ? left : 0
        for (layer, to) in targets { slides.slide(layer, to: to, over: time) }
        if let before, time > 0 {
            let fade = CABasicAnimation(keyPath: "contents")
            (fade.fromValue, fade.toValue, fade.duration) = (before, copy.contents, time)
            copy.add(fade, forKey: "arrive")
        }
        CATransaction.commit()
        slidesEnd = CACurrentMediaTime() + time
    }

    func remove() {
        builder = nil
        curtain.removeFromSuperview()
    }

    /// The text view's bounds moved by `dy` with nothing on screen moving: the curtain stays
    /// where it is on screen, and so does everything drawn in it, mid-slide or not.
    func follow(boundsBy dy: CGFloat) {
        guard dy != 0 else { return }
        visible.origin.y += dy
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        curtain.frame = visible
        content.bounds.origin = visible.origin
        for slice in slices { slides.shift(slice.layer, by: dy) }
        slides.shift(copy, by: dy)
        CATransaction.commit()
    }

    /// Where a frame's top-left corner (text view coordinates) is drawn, on the pixel grid.
    func inCurtain(_ frame: CGRect) -> CGPoint {
        CGPoint(x: frame.minX, y: painter.pixel(frame.minY))
    }

    #if DEBUG
        /// What the copy shows now.
        var copyDrawing: CGImage? {
            guard let contents = copy.contents else { return nil }
            return (contents as! CGImage)
        }

        /// The stretch of the block the copy's drawing covers (its own coordinates), and how
        /// far below the block's top on the pixel grid that drawing starts.
        var copyWindow: (window: ClosedRange<CGFloat>, offset: CGFloat)? {
            copyImage.map { ($0.window, $0.offset) }
        }

        /// The tallest drawing any slice holds, in pixels.
        var tallestSlice: Int {
            slices.flatMap { [$0.home, $0.closed] }.compactMap { $0?.height }.max() ?? 0
        }

        /// Where each run's top is drawn now on screen; nil while hidden or sliding.
        var drawnOnScreen: [CGFloat?] {
            slices.map {
                $0.layer.isHidden || slides.sliding($0.layer)
                    ? nil : slides.drawn($0.layer).y - $0.shown - visible.minY
            }
        }

        /// Where each run's top is drawn on screen as its slide starts; nil while hidden.
        var slideStarts: [CGFloat?] {
            slices.map {
                $0.layer.isHidden ? nil : slides.start($0.layer).y - $0.shown - visible.minY
            }
        }
    #endif
}

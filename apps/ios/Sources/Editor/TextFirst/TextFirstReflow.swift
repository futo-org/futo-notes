import UIKit
import os

// A block drag's live preview (#448): an opaque curtain over the visible note, painted with the
// editor's surface colour, holding one slice per run of the plan and a dimmed copy of the
// block. The slices slide to where the plan draws them for the gap the finger chose; the note
// itself is not touched until the drop. Slices are drawn by the editor's own fragment drawing
// in idle time after the lift, so the first gap change only moves layers. Until the gap first
// leaves home the curtain is not shown: the note with its dimmed block looks the same.

@MainActor
final class TextFirstReflow {
    private(set) var plan: TextFirstReflowPlan
    private(set) var gap: Int
    private(set) var closedLine: TextFirstClosedLine?
    let painter: TextFirstSlicePainter
    /// The text view bounds the curtain covers; it follows the note's scroll (#449).
    private(set) var visible: CGRect
    let curtain = UIView()
    private(set) var isOpen = false
    /// Going back to the note as it is, for the drop line to take over.
    private(set) var retreating = false
    /// When the slides last started end.
    private(set) var slidesEnd: CFTimeInterval = 0

    @MainActor private struct Slice {
        let layer = TextFirstReflow.prepare(CALayer())
        /// The run's drawing, from `offset` below its top (only the part near the screen of a
        /// run far taller than it is drawn), and once a photo's line has closed up.
        var home: CGImage?
        var offset: CGFloat = 0
        var closed: CGImage?
        /// How far below the run's top the layer's drawing starts now.
        var shown: CGFloat = 0
    }
    /// The slices and the copy, in the text view's content coordinates: a scroll moves this
    /// layer alone, so slides in flight and the gap rule's reading of them stay true.
    private let content = CALayer()
    /// What the block is known to take in a gap and out of its place, kept for when it has
    /// scrolled away (#449).
    private(set) var known: (room: CGFloat, left: CGFloat)
    private var slices: [Slice]
    private let copy = CALayer()
    /// The copy's drawing, the stretch of the block (its own coordinates) it covers, and how far
    /// below the block's top (on the pixel grid) the drawing starts.
    private var copyImage: (image: CGImage, window: ClosedRange<CGFloat>, offset: CGFloat)?
    /// A photo lifted out of a line, drawn as the line of its own it becomes, for a gap.
    private var awayImage: CGImage?
    /// The card the curtain goes under.
    private weak var card: UIView?
    private let slides = TextFirstSlides()
    private var builder: TextFirstIdleBuilder?
    /// Debug timing of the idle drawing.
    private var building = (spent: CFTimeInterval(0), frames: 0, logged: false)

    init(
        _ plan: TextFirstReflowPlan, closedLine: TextFirstClosedLine?,
        painter: TextFirstSlicePainter, under card: UIView
    ) {
        (self.plan, self.closedLine, self.painter, self.card) = (plan, closedLine, painter, card)
        gap = plan.home
        known = (plan.room, plan.left)
        visible = painter.textView.bounds
        slices = plan.runs.map { _ in Slice() }
        curtain.isUserInteractionEnabled = false
        curtain.clipsToBounds = true
        copy.opacity = TextFirstReflowMotion.dim
        prepare(copy)
    }

    /// Draw the slices a few at a time, frame by frame, until all are drawn.
    func buildInIdleTime() {
        builder = TextFirstIdleBuilder { [weak self] in self?.buildSome() ?? false }
    }

    /// The slot a release now lands on; nil at home.
    var slot: TextFirstBlockSlot? { plan.slot(gap) }

    /// Where the copy of the block is drawn now (text view coordinates, on the pixel grid).
    var copyFrame: CGRect {
        let frame = plan.copy(gap)
        return CGRect(
            x: frame.minX, y: painter.pixel(frame.minY), width: frame.width, height: frame.height)
    }

    /// The finger is at `y` (text view coordinates): open the gap the plan chooses against the
    /// runs where they are drawn now, mid-slide included, the first time it leaves home showing
    /// the curtain. True when the gap moved, to a slot.
    func follow(_ y: CGFloat) -> Bool {
        guard !retreating else { return false }
        let drawn = isOpen ? slices.map { slides.drawn($0.layer).y - $0.shown } : nil
        let moved = plan.gap(
            from: gap, finger: min(max(y, visible.minY), visible.maxY), drawn: drawn)
        guard moved != gap else { return false }
        if !isOpen { open() }
        let interval = TextFirstReflowMotion.signposts.beginInterval("gap")
        let started = CACurrentMediaTime()
        gap = moved
        place(animated: true)
        TextFirstReflowMotion.signposts.endInterval("gap", interval)
        TextFirstReflowMotion.log.debug(
            "gap moved in \((CACurrentMediaTime() - started) * 1000, format: .fixed(precision: 2), privacy: .public) ms"
        )
        return moved != plan.home
    }

    /// The layout changed under the drag (a photo decoded, a rotation): `plan` is read from it.
    /// The gap stays on its slot, or goes home when that slot is gone, and is judged again under
    /// the still finger; a gap that opens so is shown at once, curtain and all, so a release
    /// never lands where nothing showed. Slices whose run and drawing are unchanged keep their
    /// drawing; replaced ones start from where the old ones were drawn and slide to their places.
    func remeasure(
        _ plan: TextFirstReflowPlan, closedLine: TextFirstClosedLine?, finger y: CGFloat
    ) {
        let bounds = painter.textView.bounds
        guard plan != self.plan || bounds != visible else { return }
        let old = self.plan
        let drawn = slices.map { slides.drawn($0.layer) }
        var next = plan.runs.map { _ in Slice() }
        var appearing: [Int] = []
        let resized = bounds.size != visible.size
        for (j, run) in plan.runs.enumerated() {
            guard
                let i = old.runs.firstIndex(where: {
                    $0.anchor == run.anchor && abs($0.inset - run.inset) < 0.5
                })
            else {
                appearing.append(j)
                continue
            }
            if !resized, old.runs[i].height == run.height, old.runs[i].closed == run.closed,
                old.runs[i].drawing == run.drawing, old.drawing == plan.drawing
            {
                (next[j].home, next[j].offset) = (slices[i].home, slices[i].offset)
                next[j].closed = slices[i].closed
            }
            next[j].layer.position = drawn[i]
            next[j].shown = slices[i].shown
        }
        if resized || old.source.size != plan.source.size { copyImage = nil }
        if resized || old.away != plan.away || old.drawing != plan.drawing { awayImage = nil }
        if plan.homeShown { known = (plan.room, plan.left) }
        for slice in slices {
            slides.forget(slice.layer)
            slice.layer.removeFromSuperlayer()
        }
        let slot = old.slot(gap)
        (self.plan, self.closedLine, visible, slices) = (plan, closedLine, bounds, next)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        curtain.frame = visible
        content.frame = curtain.bounds
        content.bounds.origin = visible.origin
        CATransaction.commit()
        gap = slot.flatMap { plan.boundary(of: $0) } ?? plan.home
        gap = plan.gap(from: gap, finger: min(max(y, visible.minY), visible.maxY))
        // What newly shows is drawn in its place at once.
        for j in appearing {
            slices[j].layer.position = CGPoint(x: 0, y: painter.pixel(plan.top(j, gap: gap)))
        }
        guard isOpen else {
            if gap != plan.home {
                let shown = gap
                gap = plan.home
                open()
                gap = shown
                place(animated: true)
            }
            return
        }
        build(all: true)
        for slice in slices {
            slice.layer.anchorPoint = .zero
            content.insertSublayer(slice.layer, below: copy)
        }
        place(animated: true)
    }

    /// Take the preview back to the note as it is (the gap home, everything in place), then
    /// call `done`: the drag goes on with the drop line.
    func retreat(_ done: @escaping () -> Void) {
        builder = nil
        retreating = true
        guard isOpen else { return done() }
        if gap != plan.home {
            gap = plan.home
            place(animated: true)
        }
        // Whatever is still sliding home, from this move or the last, gets there first.
        let left = slidesEnd - CACurrentMediaTime()
        guard left > 0 else { return done() }
        DispatchQueue.main.asyncAfter(deadline: .now() + left) { done() }
    }

    /// The release: the copy is drawn solid at once.
    func solidify() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        copy.opacity = 1
        CATransaction.commit()
    }

    /// The move is in the note under the curtain: slide each run, and the copy, from where it
    /// is drawn to where the note now draws it (`runs`, `block`: text view coordinates, nil for
    /// a run no longer on screen), drawn from the note itself. The copy's drawing fades into the
    /// block's as it arrives (a box or indent it gained on arrival comes in, not pops).
    func settle(runs: [CGRect], block: CGRect?, over duration: CFTimeInterval) {
        builder = nil
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        // What is drawn beyond a margin around the screen cannot slide into view.
        let reach = visible.insetBy(dx: 0, dy: -visible.height / 4)
        for (j, frame) in runs.enumerated() where j < slices.count {
            let layer = slices[j].layer
            let shown = frame.intersection(reach)
            guard !shown.isNull, shown.height > 0 else {
                layer.isHidden = true
                continue
            }
            show(draw(shown, layingOut: false), in: layer)
            slides.slide(layer, to: inCurtain(shown), over: duration)
        }
        if let block = block?.intersection(reach), !block.isNull {
            let before = copy.contents
            show(draw(block, layingOut: false), in: copy)
            slides.slide(copy, to: inCurtain(block), over: duration)
            let fade = CABasicAnimation(keyPath: "contents")
            (fade.fromValue, fade.toValue, fade.duration) = (before, copy.contents, duration)
            copy.add(fade, forKey: "arrive")
        }
        CATransaction.commit()
        slidesEnd = CACurrentMediaTime() + duration
    }

    func remove() {
        builder = nil
        curtain.removeFromSuperview()
    }

    /// The text view's bounds moved by `dy` with nothing on screen moving (the move was
    /// committed and the screen held still): the curtain stays where it is on screen.
    func follow(boundsBy dy: CGFloat) {
        guard dy != 0 else { return }
        visible.origin.y += dy
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        curtain.frame = visible
        content.bounds.origin = visible.origin
        CATransaction.commit()
    }

    /// Where a frame's top-left corner (text view coordinates) is drawn, on the pixel grid.
    private func inCurtain(_ frame: CGRect) -> CGPoint {
        CGPoint(x: frame.minX, y: painter.pixel(frame.minY))
    }

    // MARK: drawing

    private func open() {
        let interval = TextFirstReflowMotion.signposts.beginInterval("open")
        build(all: true)
        curtain.frame = visible
        curtain.backgroundColor = painter.surface
        content.anchorPoint = .zero
        content.frame = curtain.bounds
        content.bounds.origin = visible.origin
        curtain.layer.addSublayer(content)
        for slice in slices {
            slice.layer.anchorPoint = .zero
            content.addSublayer(slice.layer)
        }
        copy.anchorPoint = .zero
        content.addSublayer(copy)
        place(animated: false)
        if let card, let view = card.superview {
            view.insertSubview(curtain, belowSubview: card)
        } else {
            painter.textView.addSubview(curtain)
        }
        isOpen = true
        TextFirstReflowMotion.signposts.endInterval("open", interval)
    }

    /// Draw what is not drawn yet: everything, or what fits this frame's budget. True while
    /// some remains.
    private func buildSome() -> Bool { build(all: false) }

    @discardableResult private func build(all: Bool) -> Bool {
        let started = CACurrentMediaTime()
        let interval = TextFirstReflowMotion.signposts.beginInterval("slices")
        defer {
            TextFirstReflowMotion.signposts.endInterval("slices", interval)
            building.spent += CACurrentMediaTime() - started
            building.frames += 1
        }
        for j in slices.indices {
            if !all, CACurrentMediaTime() - started > TextFirstReflowMotion.budget { return true }
            let run = plan.runs[j]
            if slices[j].home == nil {
                // A run far taller than the screen is drawn a screen around what shows.
                let from = max(run.top, visible.minY - visible.height)
                let to = min(run.bottom, visible.maxY + visible.height)
                slices[j].home = painter.paint(
                    band(from, max(from, to)), from: run.anchor.offset, erasing: erased)
                slices[j].offset = painter.pixel(from) - painter.pixel(run.top)
            }
            if slices[j].closed == nil, run.closed != run.height || closedLine != nil {
                slices[j].closed = closedDrawing(j)
            }
        }
        if !all, CACurrentMediaTime() - started > TextFirstReflowMotion.budget { return true }
        drawCopy(for: gap)
        if awayImage == nil, let closedLine {
            awayImage = closedLine.paintPhoto(at: plan.source.minY, with: painter)
        }
        if builder != nil || all, !building.logged {
            building.logged = true
            let spent = (building.spent + CACurrentMediaTime() - started) * 1000
            TextFirstReflowMotion.log.debug(
                "slices built: \(self.slices.count, privacy: .public) runs, \(spent, format: .fixed(precision: 1), privacy: .public) ms over \(self.building.frames + 1, privacy: .public) frames\(all ? " (at the first gap change)" : "", privacy: .public)"
            )
        }
        builder = nil
        return false
    }

    /// The part of a photo's line run `j` is once the photo has left; its home drawing for a
    /// run outside that line.
    private func closedDrawing(_ j: Int) -> CGImage? {
        let run = plan.runs[j]
        guard let closedLine, let line = plan.closing,
            run.top >= line.top - 0.5, run.bottom <= line.bottom + 0.5
        else { return slices[j].home }
        let from = line.closedY(run.top - line.top)
        return closedLine.paint(from...(from + run.closed), at: line.top, with: painter)
    }

    /// A lifted photo is drawn by the copy, so the runs leave its place blank.
    private var erased: CGRect? { plan.closing == nil ? nil : plan.source }

    private func band(_ top: CGFloat, _ bottom: CGFloat) -> CGRect {
        let y = painter.pixel(top)
        return CGRect(
            x: visible.minX, y: y, width: visible.width, height: painter.pixel(bottom) - y)
    }

    private func pixelHeight(_ frame: CGRect) -> CGFloat {
        painter.pixel(frame.maxY) - painter.pixel(frame.minY)
    }

    /// `frame` (text view coordinates) drawn from the note as it is now.
    private func draw(_ frame: CGRect, layingOut: Bool = true) -> CGImage? {
        let top = painter.pixel(frame.minY)
        return painter.paint(
            CGRect(x: frame.minX, y: top, width: frame.width, height: pixelHeight(frame)),
            layingOut: layingOut)
    }

    /// The stretch of the block the copy shows with the gap at `gap`: the part that shows there
    /// and a quarter screen around it (all of a block that fits), so nothing far off screen is
    /// laid out to draw it.
    private func window(for gap: Int) -> ClosedRange<CGFloat> {
        let top = plan.copy(gap).minY
        let from = min(max(0, visible.minY - visible.height / 4 - top), plan.source.height)
        let to = min(plan.source.height, visible.maxY + visible.height / 4 - top)
        return from...max(from, to)
    }

    private func drawCopy(for gap: Int) {
        let needed = window(for: gap)
        if let drawn = copyImage?.window, drawn.contains(needed.lowerBound),
            drawn.contains(needed.upperBound)
        {
            return
        }
        let source = plan.source
        let top = painter.pixel(source.minY + needed.lowerBound)
        let rect = CGRect(
            x: source.minX, y: top, width: source.width,
            height: painter.pixel(source.minY + needed.upperBound) - top)
        let anchor = plan.closing?.anchor ?? plan.sourceAnchor
        guard let image = painter.paint(rect, from: anchor) else { return }
        copyImage = (image, needed, top - painter.pixel(source.minY))
        copy.contents = image
    }

    /// `image` in `layer`, the layer exactly the image's size, so it is never scaled or cropped
    /// (a layer's content gravity is upside down on iOS: `.topLeft` pins the bottom edge).
    private func show(_ image: CGImage?, in layer: CALayer) {
        layer.contentsScale = painter.scale
        layer.contents = image
        layer.bounds.size =
            image.map {
                CGSize(
                    width: CGFloat($0.width) / painter.scale,
                    height: CGFloat($0.height) / painter.scale)
            } ?? .zero
    }

    /// A slice's drawing is shown pixel for pixel from its top-left corner, never scaled.
    @discardableResult private static func prepare(_ layer: CALayer) -> CALayer {
        layer.anchorPoint = .zero
        layer.contentsGravity = .topLeft
        layer.contentsScale = UITraitCollection.current.displayScale
        return layer
    }

    private func prepare(_ layer: CALayer) {
        Self.prepare(layer)
        layer.contentsScale = painter.scale
    }

    /// Put every slice and the copy where the plan draws them for the gap.
    private func place(animated: Bool) {
        drawCopy(for: gap)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let duration = animated ? TextFirstReflowMotion.slide : 0
        for (j, slice) in slices.enumerated() {
            let closed = gap != plan.home
            let shut = closed ? slices[j].closed : nil
            show(shut ?? slice.home, in: slice.layer)
            slices[j].shown = shut == nil ? slice.offset : 0
            let top = painter.pixel(plan.top(j, gap: gap))
            slides.slide(slice.layer, to: CGPoint(x: 0, y: top + slices[j].shown), over: duration)
        }
        if plan.closing != nil, gap != plan.home, let awayImage {
            let frame = copyFrame
            show(awayImage, in: copy)
            slides.slide(copy, to: inCurtain(frame), over: duration)
        } else if let drawn = copyImage {
            let frame = copyFrame
            show(drawn.image, in: copy)
            slides.slide(
                copy,
                to: CGPoint(x: frame.minX, y: frame.minY + drawn.offset),
                over: duration)
        }
        CATransaction.commit()
        if animated { slidesEnd = CACurrentMediaTime() + TextFirstReflowMotion.slide }
    }
}

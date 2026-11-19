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
    /// The text view bounds the curtain covers; it follows the note's scroll (#449). Set here
    /// and by the landing (+Landing), as are the members below without `private`.
    var visible: CGRect
    let curtain = UIView()
    private(set) var isOpen = false
    /// Going back to the note as it is, for the drop line to take over.
    private(set) var retreating = false
    /// When the slides last started end.
    var slidesEnd: CFTimeInterval = 0

    @MainActor struct Slice {
        let layer = TextFirstReflow.prepare(CALayer())
        /// The run's drawing, from `offset` below its top (only the part near the screen of a
        /// run far taller than it is drawn), and once a photo's line has closed up.
        var home: CGImage?
        var offset: CGFloat = 0
        var closed: CGImage?
        /// How far below the run's top `closed` starts (it is `home` outside a photo's line).
        var closedOffset: CGFloat = 0
        /// How far below the run's top the layer's drawing starts now.
        var shown: CGFloat = 0
    }
    /// The slices and the copy, in the text view's content coordinates: a scroll moves this
    /// layer alone, so slides in flight and the gap rule's reading of them stay true.
    let content = CALayer()
    /// What the block is known to take in a gap and out of the note (`TextFirstReflowPlan
    /// .leaves`), kept for when it has scrolled away (#449).
    private(set) var known: (room: CGFloat, left: CGFloat)
    /// The block's height last measured, and the width and drawing of its images it was
    /// measured at: an estimate never replaces it while those hold.
    private(set) var measured: (height: CGFloat, width: CGFloat, drawing: Int)?
    /// Draws `rect` (text view coordinates) of the block laid out on its own, its top at the
    /// given y: the copy once the block's own text is not laid out.
    var drawBlock: ((CGRect, CGFloat) -> CGImage?)?
    var slices: [Slice]
    let copy = CALayer()
    /// The copy's drawing, the stretch of the block (its own coordinates) it covers, and how far
    /// below the block's top (on the pixel grid) the drawing starts.
    var copyImage: (image: CGImage, window: ClosedRange<CGFloat>, offset: CGFloat)?
    /// How far below the copy's frame its drawing starts now.
    var copyShown: CGFloat = 0
    /// A photo lifted out of a line, drawn as the line of its own it becomes, for a gap: the
    /// stretch of it that can show, as `copyImage`.
    var awayImage: (image: CGImage, window: ClosedRange<CGFloat>, offset: CGFloat)?
    /// The card the curtain goes under.
    private weak var card: UIView?
    let slides = TextFirstSlides()
    var builder: TextFirstIdleBuilder?
    #if DEBUG
        /// Debug timing of the idle drawing.
        private var building = (spent: CFTimeInterval(0), frames: 0, logged: false)
    #endif

    init(
        _ plan: TextFirstReflowPlan, closedLine: TextFirstClosedLine?,
        painter: TextFirstSlicePainter, under card: UIView
    ) {
        (self.plan, self.closedLine, self.painter, self.card) = (plan, closedLine, painter, card)
        gap = plan.home
        known = (plan.room, plan.leaves)
        if plan.exact, closedLine == nil {
            measured = (plan.room, plan.away.width, plan.blockDrawing)
        }
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

    /// The layout changed or the note scrolled under the drag: `plan` is read from it. The gap
    /// stays on its slot, or goes home when that slot is gone, and is judged again under the
    /// still finger as a finger move judges it, against the runs where they are drawn now; a
    /// gap that opens so is shown at once, curtain and all, so a release never lands where
    /// nothing showed. A run that goes on keeps its layer and the slide it is on, and its
    /// drawing while it still draws the run as it is, around what shows; one that newly shows
    /// is drawn in its place at once.
    func remeasure(
        _ plan: TextFirstReflowPlan, closedLine: TextFirstClosedLine?, finger y: CGFloat
    ) {
        let bounds = painter.textView.bounds
        guard plan != self.plan || bounds != visible else { return }
        let old = self.plan
        let start = old.slot(gap).flatMap { plan.boundary(of: $0) } ?? plan.home
        let resized = bounds.size != visible.size
        var next: [Slice] = []
        var drawn: [CGFloat] = []
        var kept = Set<Int>()
        for (j, run) in plan.runs.enumerated() {
            guard
                let i = old.runs.indices.first(where: {
                    !kept.contains($0) && old.runs[$0].anchor == run.anchor
                        && abs(old.runs[$0].inset - run.inset) < 0.5
                })
            else {
                next.append(Slice())
                drawn.append(plan.top(j, gap: start))
                continue
            }
            kept.insert(i)
            var slice = slices[i]
            let was = old.runs[i]
            if resized || was.height != run.height || was.closed != run.closed
                || was.drawing != run.drawing || old.drawing != plan.drawing
                || !covers(slice, run, around: bounds)
            {
                (slice.home, slice.closed, slice.offset) = (nil, nil, 0)
            }
            next.append(slice)
            drawn.append(slides.drawn(slice.layer).y - slice.shown)
        }
        for (i, slice) in slices.enumerated() where !kept.contains(i) {
            slides.forget(slice.layer)
            slice.layer.removeFromSuperlayer()
        }
        let redrawn = old.blockDrawing != plan.blockDrawing
        if resized || old.source.size != plan.source.size || redrawn { copyImage = nil }
        if resized || old.away != plan.away || old.drawing != plan.drawing || redrawn {
            awayImage = nil
        }
        // Known from where the block shows, or from its photo's line laid out again apart.
        if plan.homeShown || (closedLine != nil && closedLine !== self.closedLine) {
            known = (plan.room, plan.leaves)
        }
        if plan.exact, plan.closing == nil, closedLine == nil {
            measured = (plan.room, plan.away.width, plan.blockDrawing)
        }
        (self.plan, self.closedLine, visible, slices) = (plan, closedLine, bounds, next)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        curtain.frame = visible
        content.frame = curtain.bounds
        content.bounds.origin = visible.origin
        CATransaction.commit()
        gap = plan.gap(
            from: start, finger: min(max(y, visible.minY), visible.maxY),
            drawn: isOpen ? drawn : nil)
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
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for (j, slice) in slices.enumerated() where slice.layer.superlayer == nil {
            slice.layer.position = CGPoint(x: 0, y: painter.pixel(plan.top(j, gap: gap)))
            content.insertSublayer(slice.layer, below: copy)
        }
        CATransaction.commit()
        place(animated: true)
    }

    /// Whether `slice` holds `run`'s drawing for all of it that may show around `bounds`.
    private func covers(_ slice: Slice, _ run: TextFirstReflowPlan.Run, around bounds: CGRect)
        -> Bool
    {
        guard let image = slice.home else { return false }
        let from = run.top + slice.offset
        let to = from + CGFloat(image.height) / painter.scale
        let margin = bounds.height / 2
        return from <= max(run.top, bounds.minY - margin) + 1
            && to >= min(run.bottom, bounds.maxY + margin) - 1
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
            #if DEBUG
                building.spent += CACurrentMediaTime() - started
                building.frames += 1
            #endif
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
                (slices[j].closed, slices[j].closedOffset) = closedDrawing(j, at: closedAt(j))
            }
        }
        if !all, CACurrentMediaTime() - started > TextFirstReflowMotion.budget { return true }
        drawCopy(for: gap)
        #if DEBUG
            if builder != nil || all, !building.logged {
                building.logged = true
                let spent = (building.spent + CACurrentMediaTime() - started) * 1000
                TextFirstReflowMotion.log.debug(
                    "slices built: \(self.slices.count, privacy: .public) runs, \(spent, format: .fixed(precision: 1), privacy: .public) ms over \(self.building.frames + 1, privacy: .public) frames\(all ? " (at the first gap change)" : "", privacy: .public)"
                )
            }
        #endif
        builder = nil
        return false
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
    func draw(_ frame: CGRect, layingOut: Bool = true) -> CGImage? {
        let top = painter.pixel(frame.minY)
        return painter.paint(
            CGRect(x: frame.minX, y: top, width: frame.width, height: pixelHeight(frame)),
            layingOut: layingOut)
    }

    /// `image` in `layer`, the layer exactly the image's size, so it is never scaled or cropped
    /// (a layer's content gravity is upside down on iOS: `.topLeft` pins the bottom edge).
    func show(_ image: CGImage?, in layer: CALayer) {
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

    /// Put every slice and the copy where the plan draws them for the gap. A layer whose
    /// drawing now starts elsewhere in its run is moved by as much, so what it shows stays put
    /// until it slides.
    private func place(animated: Bool) {
        drawCopy(for: gap)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let duration = animated ? TextFirstReflowMotion.slide : 0
        var slid = false
        for j in slices.indices where gap != plan.home { closedFits(j) }
        for (j, slice) in slices.enumerated() {
            let closed = gap != plan.home
            let shut = closed ? slices[j].closed : nil
            show(shut ?? slice.home, in: slice.layer)
            let shown = shut == nil ? slice.offset : slice.closedOffset
            if shown != slice.shown { slides.shift(slice.layer, by: shown - slice.shown) }
            slices[j].shown = shown
            let top = painter.pixel(plan.top(j, gap: gap))
            slid =
                slides.slide(slice.layer, to: CGPoint(x: 0, y: top + shown), over: duration)
                || slid
        }
        var copyAt: (CGRect, CGFloat)?
        if closedLine != nil, gap != plan.home, let away = drawAway(for: gap) {
            show(away.image, in: copy)
            copyAt = (copyFrame, away.offset)
        } else if let drawn = copyImage {
            show(drawn.image, in: copy)
            copyAt = (copyFrame, drawn.offset)
        }
        if let (frame, shown) = copyAt {
            if shown != copyShown { slides.shift(copy, by: shown - copyShown) }
            copyShown = shown
            slid =
                slides.slide(
                    copy, to: CGPoint(x: frame.minX, y: frame.minY + shown), over: duration)
                || slid
        }
        CATransaction.commit()
        if slid { slidesEnd = CACurrentMediaTime() + TextFirstReflowMotion.slide }
    }
}

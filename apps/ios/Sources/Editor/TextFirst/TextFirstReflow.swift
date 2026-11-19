import UIKit
import os

// A block drag's live preview (#448): an opaque curtain over the visible note, painted with the
// editor's surface colour, holding one slice per run of the plan and a dimmed copy of the
// block. The slices slide to where the plan draws them for the gap the finger chose; the note
// itself is not touched until the drop. Slices are drawn by the editor's own fragment drawing
// in idle time after the lift, so the first gap change only moves layers. Until the gap first
// leaves home the curtain is not shown: the note with its dimmed block looks the same.

enum TextFirstReflowMotion {
    /// Neighbours slide over 0.18 s with the web editor's easing.
    static let slide: CFTimeInterval = 0.18
    static let easing = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.3, 1)
    /// The whole landing, from the release to the curtain coming down.
    static let landingCap: CFTimeInterval = 0.4
    /// The copy in the gap, and the block in its place before the gap first moves.
    static let dim: Float = 0.35
    /// Idle-time drawing per frame.
    static let budget: CFTimeInterval = 0.004

    static let log = Logger(subsystem: "com.futo.notes", category: "block-reflow")
    static let signposts = OSSignposter(logger: log)
}

@MainActor
final class TextFirstReflow {
    private(set) var plan: TextFirstReflowPlan
    private(set) var gap: Int
    private(set) var closedLine: TextFirstClosedLine?
    let painter: TextFirstSlicePainter
    /// The text view bounds the curtain covers (scrolling is the drop line's, #449).
    private(set) var visible: CGRect
    let curtain = UIView()
    private(set) var isOpen = false
    /// Going back to the note as it is, for the drop line to take over.
    private(set) var retreating = false
    /// When the slides last started end.
    private(set) var slidesEnd: CFTimeInterval = 0

    @MainActor private struct Slice {
        let layer = TextFirstReflow.prepare(CALayer())
        var home: CGImage?
        var closed: CGImage?
    }
    private var slices: [Slice]
    private let copy = CALayer()
    /// The copy's drawing and the stretch of the block (its own coordinates) it covers.
    private var copyImage: (image: CGImage, window: ClosedRange<CGFloat>)?
    private var builder: TextFirstIdleBuilder?

    init(
        _ plan: TextFirstReflowPlan, closedLine: TextFirstClosedLine?,
        painter: TextFirstSlicePainter
    ) {
        (self.plan, self.closedLine, self.painter) = (plan, closedLine, painter)
        gap = plan.home
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

    /// The finger is at `y` (text view coordinates): open the gap the plan chooses, the first
    /// time it leaves home showing the curtain. True when the gap moved, to a slot.
    func follow(_ y: CGFloat, under card: UIView) -> Bool {
        guard !retreating else { return false }
        let moved = plan.gap(from: gap, finger: min(max(y, visible.minY), visible.maxY))
        guard moved != gap else { return false }
        if !isOpen { open(under: card) }
        let interval = TextFirstReflowMotion.signposts.beginInterval("gap")
        gap = moved
        place(animated: true)
        TextFirstReflowMotion.signposts.endInterval("gap", interval)
        return moved != plan.home
    }

    /// The layout changed under the drag (a photo decoded, a rotation): `plan` is read from it.
    /// The gap stays on its slot, or goes home when that slot is gone, and is judged again under
    /// the still finger. Slices whose run is unchanged keep their drawing; replaced ones start
    /// from where the old ones were drawn and slide to their places.
    func remeasure(
        _ plan: TextFirstReflowPlan, closedLine: TextFirstClosedLine?, finger y: CGFloat
    ) {
        let bounds = painter.textView.bounds
        guard plan != self.plan || bounds != visible else { return }
        let old = self.plan
        let drawn = slices.map { $0.layer.presentation()?.position ?? $0.layer.position }
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
            if !resized, old.runs[i].height == run.height, old.runs[i].closed == run.closed {
                next[j].home = slices[i].home
                next[j].closed = slices[i].closed
            }
            next[j].layer.position = drawn[i]
        }
        if resized || old.source.size != plan.source.size { copyImage = nil }
        for slice in slices { slice.layer.removeFromSuperlayer() }
        let slot = old.slot(gap)
        (self.plan, self.closedLine, visible, slices) = (plan, closedLine, bounds, next)
        gap = slot.flatMap { plan.boundary(of: $0) } ?? plan.home
        gap = plan.gap(from: gap, finger: min(max(y, visible.minY), visible.maxY))
        // What newly shows is drawn in its place at once.
        for j in appearing {
            slices[j].layer.position = CGPoint(
                x: 0, y: painter.pixel(plan.top(j, gap: gap)) - visible.minY)
        }
        guard isOpen else { return }
        curtain.frame = visible
        build(all: true)
        for slice in slices {
            slice.layer.anchorPoint = .zero
            curtain.layer.insertSublayer(slice.layer, below: copy)
        }
        place(animated: true)
    }

    /// Take the preview back to the note as it is (the gap home, everything in place), then
    /// call `done`: the drag goes on with the drop line.
    func retreat(_ done: @escaping () -> Void) {
        builder = nil
        retreating = true
        guard isOpen, gap != plan.home else { return done() }
        gap = plan.home
        place(animated: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + TextFirstReflowMotion.slide) { done() }
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
            layer.contents = draw(shown)
            layer.bounds.size = CGSize(width: shown.width, height: pixelHeight(shown))
            slide(layer, to: inCurtain(shown), over: duration)
        }
        if let block = block?.intersection(reach), !block.isNull {
            let before = copy.contents
            copy.contents = draw(block)
            copy.bounds.size = CGSize(width: block.width, height: pixelHeight(block))
            slide(copy, to: inCurtain(block), over: duration)
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
        curtain.frame = visible
    }

    /// Where a frame's top-left corner (text view coordinates) is on the curtain, on the pixel
    /// grid.
    private func inCurtain(_ frame: CGRect) -> CGPoint {
        CGPoint(x: frame.minX - visible.minX, y: painter.pixel(frame.minY) - visible.minY)
    }

    // MARK: drawing

    private func open(under card: UIView) {
        let interval = TextFirstReflowMotion.signposts.beginInterval("open")
        build(all: true)
        curtain.frame = visible
        curtain.backgroundColor = painter.surface
        for slice in slices {
            slice.layer.anchorPoint = .zero
            curtain.layer.addSublayer(slice.layer)
        }
        copy.anchorPoint = .zero
        curtain.layer.addSublayer(copy)
        place(animated: false)
        card.superview?.insertSubview(curtain, belowSubview: card)
        isOpen = true
        TextFirstReflowMotion.signposts.endInterval("open", interval)
    }

    /// Draw what is not drawn yet: everything, or what fits this frame's budget. True while
    /// some remains.
    private func buildSome() -> Bool { build(all: false) }

    @discardableResult private func build(all: Bool) -> Bool {
        let started = CACurrentMediaTime()
        let interval = TextFirstReflowMotion.signposts.beginInterval("slices")
        defer { TextFirstReflowMotion.signposts.endInterval("slices", interval) }
        for j in slices.indices {
            if !all, CACurrentMediaTime() - started > TextFirstReflowMotion.budget { return true }
            let run = plan.runs[j]
            if slices[j].home == nil {
                slices[j].home = painter.paint(
                    band(run.top, run.bottom), from: run.anchor.offset, erasing: erased)
            }
            if slices[j].closed == nil, run.closed != run.height || closedLine != nil {
                slices[j].closed = closedDrawing(j)
            }
        }
        if !all, CACurrentMediaTime() - started > TextFirstReflowMotion.budget { return true }
        drawCopy(for: gap)
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
    private func draw(_ frame: CGRect) -> CGImage? {
        let top = painter.pixel(frame.minY)
        return painter.paint(
            CGRect(x: frame.minX, y: top, width: frame.width, height: pixelHeight(frame)))
    }

    /// The stretch of the block the copy shows with the gap at `gap`: all of it, or for a block
    /// taller than two screens the part that shows there.
    private func window(for gap: Int) -> ClosedRange<CGFloat> {
        let source = plan.source
        guard source.height > 2 * visible.height else { return 0...source.height }
        let top = plan.copy(gap).minY
        let from = max(0, visible.minY - top - visible.height / 2)
        return from...min(source.height, from + 2 * visible.height)
    }

    private func drawCopy(for gap: Int) {
        let needed = window(for: gap)
        if let drawn = copyImage?.window, drawn.contains(needed.lowerBound),
            drawn.contains(needed.upperBound)
        {
            return
        }
        let source = plan.source
        let top = painter.pixel(source.minY)
        let rect = CGRect(
            x: source.minX, y: top + needed.lowerBound, width: source.width,
            height: painter.pixel(source.maxY) - top - needed.lowerBound
                - (source.height - needed.upperBound))
        let anchor = plan.closing?.anchor ?? plan.sourceAnchor
        guard let image = painter.paint(rect, from: anchor) else { return }
        copyImage = (image, needed)
        copy.contents = image
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
            slice.layer.contentsScale = painter.scale
            slice.layer.contents = closed ? slices[j].closed ?? slice.home : slice.home
            let height = closed ? plan.runs[j].closed : plan.runs[j].height
            let top = painter.pixel(plan.top(j, gap: gap))
            slice.layer.bounds.size = CGSize(
                width: visible.width, height: painter.pixel(top + height) - top)
            slide(slice.layer, to: CGPoint(x: 0, y: top - visible.minY), over: duration)
        }
        if let window = copyImage?.window {
            let frame = copyFrame
            copy.bounds.size = CGSize(
                width: frame.width,
                height: CGFloat(copyImage.map { $0.image.height } ?? 0) / painter.scale)
            slide(
                copy,
                to: CGPoint(
                    x: frame.minX - visible.minX, y: frame.minY + window.lowerBound - visible.minY),
                over: duration)
        }
        CATransaction.commit()
        if animated { slidesEnd = CACurrentMediaTime() + TextFirstReflowMotion.slide }
    }

    /// Move `layer` to `to` (its top-left corner, curtain coordinates), sliding from where it
    /// is drawn now.
    private func slide(_ layer: CALayer, to: CGPoint, over duration: CFTimeInterval) {
        let from = layer.presentation()?.position ?? layer.position
        layer.position = to
        guard duration > 0, layer.superlayer != nil,
            abs(from.y - to.y) > 0.01 || abs(from.x - to.x) > 0.01
        else { return }
        let animation = CABasicAnimation(keyPath: "position")
        (animation.fromValue, animation.toValue) = (NSValue(cgPoint: from), NSValue(cgPoint: to))
        animation.duration = duration
        animation.timingFunction = TextFirstReflowMotion.easing
        layer.add(animation, forKey: "slide")
    }
}

/// Runs `step` once per display frame until it returns false or this object goes away.
@MainActor
final class TextFirstIdleBuilder {
    private var link: CADisplayLink?
    private let step: () -> Bool

    init(_ step: @escaping () -> Bool) {
        self.step = step
        let link = CADisplayLink(
            target: TextFirstIdleProxy(self), selector: #selector(TextFirstIdleProxy.frame))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    isolated deinit { link?.invalidate() }

    fileprivate func frame() {
        if !step() {
            link?.invalidate()
            link = nil
        }
    }
}

private final class TextFirstIdleProxy: NSObject {
    weak var builder: TextFirstIdleBuilder?
    init(_ builder: TextFirstIdleBuilder) { self.builder = builder }
    @MainActor @objc func frame(_ link: CADisplayLink) {
        if let builder { builder.frame() } else { link.invalidate() }
    }
}

import UIKit
import os

// The timing of a block drag's live preview (#448): the web editor's slide and landing, the
// copy's dim, how a slide eases, and the idle-time drawing after the lift.

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

    /// The easing at `t` (0...1 of the slide's time): how far along its way a slide is.
    static func eased(_ t: Double) -> Double {
        // cubic-bezier(0.2, 0.9, 0.3, 1): find the curve's parameter for time `t`, then its
        // progress there.
        func bezier(_ p1: Double, _ p2: Double, _ u: Double) -> Double {
            3 * (1 - u) * (1 - u) * u * p1 + 3 * (1 - u) * u * u * p2 + u * u * u
        }
        var (low, high) = (0.0, 1.0)
        for _ in 0..<30 {
            let u = (low + high) / 2
            if bezier(0.2, 0.3, u) < t { low = u } else { high = u }
        }
        return bezier(0.9, 1, (low + high) / 2)
    }

    static let log = Logger(subsystem: "com.futo.notes", category: "block-reflow")
    static let signposts = OSSignposter(logger: log)
}

/// The slides of a preview's layers, worked out from the slides themselves, so where a layer is
/// drawn is known before the screen has drawn a frame.
@MainActor
final class TextFirstSlides {
    /// Each sliding layer's slide: where it started, where it goes, and when it began.
    private var motions: [ObjectIdentifier: (from: CGPoint, to: CGPoint, begun: CFTimeInterval)] =
        [:]

    /// Where `layer` is drawn now (its top-left corner, curtain coordinates): along its slide,
    /// worked out from the slide itself, so it is known before the screen has drawn a frame.
    func drawn(_ layer: CALayer) -> CGPoint {
        guard let motion = motions[ObjectIdentifier(layer)] else { return layer.position }
        let t = (CACurrentMediaTime() - motion.begun) / TextFirstReflowMotion.slide
        guard t < 1 else { return layer.position }
        let eased = CGFloat(TextFirstReflowMotion.eased(max(0, t)))
        return CGPoint(
            x: motion.from.x + (motion.to.x - motion.from.x) * eased,
            y: motion.from.y + (motion.to.y - motion.from.y) * eased)
    }

    /// Move `layer` to `to` (its top-left corner, curtain coordinates), sliding from where it
    /// is drawn now.
    func slide(_ layer: CALayer, to: CGPoint, over duration: CFTimeInterval) {
        let from = drawn(layer)
        layer.position = to
        motions[ObjectIdentifier(layer)] = nil
        guard duration > 0, layer.superlayer != nil,
            abs(from.y - to.y) > 0.01 || abs(from.x - to.x) > 0.01
        else { return }
        if duration == TextFirstReflowMotion.slide {
            motions[ObjectIdentifier(layer)] = (from, to, CACurrentMediaTime())
        }
        let animation = CABasicAnimation(keyPath: "position")
        (animation.fromValue, animation.toValue) = (NSValue(cgPoint: from), NSValue(cgPoint: to))
        animation.duration = duration
        animation.timingFunction = TextFirstReflowMotion.easing
        layer.add(animation, forKey: "slide")
    }

    /// `layer` is let go: its slide goes with it, as a new layer may come to have its identity.
    func forget(_ layer: CALayer) { motions[ObjectIdentifier(layer)] = nil }
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

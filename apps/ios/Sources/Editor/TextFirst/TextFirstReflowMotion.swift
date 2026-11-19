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

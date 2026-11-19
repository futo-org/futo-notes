import UIKit
import os

// The timing of a block drag's live preview (#448): the web editor's slide and landing, the
// copy's dim, how a slide eases, and the idle-time drawing after the lift.

enum TextFirstReflowMotion {
    /// Neighbours slide over 0.18 s with the web editor's easing.
    static let slide: CFTimeInterval = 0.18
    static let easing = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.3, 1)
    /// The whole landing, from the release to the curtain coming down (a test may shorten it).
    #if DEBUG
        nonisolated(unsafe) static var landingCap: CFTimeInterval = 0.4
    #else
        static let landingCap: CFTimeInterval = 0.4
    #endif
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
    /// is drawn now. A slide already on its way there goes on as it is. True when a slide
    /// started.
    @discardableResult func slide(_ layer: CALayer, to: CGPoint, over duration: CFTimeInterval)
        -> Bool
    {
        let id = ObjectIdentifier(layer)
        if duration > 0, layer.position == to, motions[id]?.to == to { return false }
        let from = drawn(layer)
        layer.position = to
        motions[id] = nil
        guard duration > 0, layer.superlayer != nil,
            abs(from.y - to.y) > 0.01 || abs(from.x - to.x) > 0.01
        else {
            layer.removeAnimation(forKey: "slide")
            return false
        }
        if duration == TextFirstReflowMotion.slide {
            motions[id] = (from, to, CACurrentMediaTime())
        }
        let animation = CABasicAnimation(keyPath: "position")
        (animation.fromValue, animation.toValue) = (NSValue(cgPoint: from), NSValue(cgPoint: to))
        animation.duration = duration
        animation.timingFunction = TextFirstReflowMotion.easing
        layer.add(animation, forKey: "slide")
        return true
    }

    /// `layer` moved `dy` in its parent's coordinates with nothing on screen moving (the
    /// parent's bounds moved as much): its slide, in flight or not, moves with it, keeping its
    /// time.
    func shift(_ layer: CALayer, by dy: CGFloat) {
        let id = ObjectIdentifier(layer)
        layer.position.y += dy
        if let motion = motions[id] {
            motions[id] = (
                CGPoint(x: motion.from.x, y: motion.from.y + dy),
                CGPoint(x: motion.to.x, y: motion.to.y + dy), motion.begun
            )
        }
        guard let slide = layer.animation(forKey: "slide")?.copy() as? CABasicAnimation,
            let from = (slide.fromValue as? NSValue)?.cgPointValue,
            let to = (slide.toValue as? NSValue)?.cgPointValue
        else { return }
        slide.fromValue = NSValue(cgPoint: CGPoint(x: from.x, y: from.y + dy))
        slide.toValue = NSValue(cgPoint: CGPoint(x: to.x, y: to.y + dy))
        layer.add(slide, forKey: "slide")
    }

    /// Where `layer`'s slide started, or where it is when it is not sliding.
    func start(_ layer: CALayer) -> CGPoint {
        guard let motion = motions[ObjectIdentifier(layer)],
            CACurrentMediaTime() - motion.begun < TextFirstReflowMotion.slide
        else { return layer.position }
        return motion.from
    }

    /// Whether `layer` is sliding now.
    func sliding(_ layer: CALayer) -> Bool { drawn(layer) != layer.position }

    /// `layer` is let go: its slide goes with it, as a new layer may come to have its identity.
    func forget(_ layer: CALayer) { motions[ObjectIdentifier(layer)] = nil }
}

#if DEBUG
    /// A long drag's cost (#449): each autoscroll frame's work in a signpost, and once a second a
    /// log line of the frames' work and gaps, the runs the preview holds and the app's memory, also
    /// kept for the debug report (`autoscroll`), so they can be seen staying flat.
    @MainActor
    final class TextFirstDragMeter {
        /// The runs the live preview holds now, for the log.
        var runs: () -> Int = { 0 }
        private(set) var report: [String: Double] = [:]
        private var work: [CFTimeInterval] = []
        private var gaps: [CFTimeInterval] = []
        private var since = CACurrentMediaTime()
        private var frames = 0

        /// Run one frame's `step`, `gap` after the frame before it. The frame's work includes the
        /// once-a-second log's.
        func frame<T>(gap: CFTimeInterval, _ step: () -> T) -> T {
            let interval = TextFirstReflowMotion.signposts.beginInterval("autoscroll frame")
            let began = CACurrentMediaTime()
            if frames == 0 { since = began }
            let result = step()
            frames += 1
            if began - since >= 1, !work.isEmpty { flush(began) }
            // Counted in the next second's report, the log's work included.
            work.append(CACurrentMediaTime() - began)
            gaps.append(gap)
            TextFirstReflowMotion.signposts.endInterval("autoscroll frame", interval)
            return result
        }

        private func flush(_ now: CFTimeInterval) {
            let ms = { (values: [CFTimeInterval], at: Double) in
                values.sorted()[Int(Double(values.count - 1) * at)] * 1000
            }
            report = [
                "frames": Double(frames), "workMedianMs": ms(work, 0.5), "workMaxMs": ms(work, 1),
                "gapMaxMs": ms(gaps, 1), "runs": Double(runs()), "footprintMB": Self.footprint(),
            ]
            let line = String(
                format:
                    "%d frames so far; work median %.2f ms max %.2f ms, longest gap %.1f ms, %d runs, "
                    + "footprint %.1f MB", frames, ms(work, 0.5), ms(work, 1), ms(gaps, 1), runs(),
                report["footprintMB"] ?? 0)
            TextFirstReflowMotion.log.info("block drag autoscroll: \(line, privacy: .public)")
            (work, gaps, since) = ([], [], now)
        }

        /// The app's memory footprint, in MB, as the system counts it against its limit.
        static func footprint() -> Double {
            var info = task_vm_info_data_t()
            var count = mach_msg_type_number_t(
                MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
            let status = withUnsafeMutablePointer(to: &info) {
                $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                    task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
                }
            }
            return status == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : 0
        }
    }

#endif

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

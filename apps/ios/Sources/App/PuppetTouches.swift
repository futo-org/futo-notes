#if DEBUG
    import UIKit
    import UIKit.UIGestureRecognizerSubclass

    /// The touches the app itself received, so `futo-puppet` can tell a tap the app never got
    /// from one it got and ignored: `axe` exits 0 either way (AGENTS.md M21), and DeviceHub
    /// takes every booted simulator's touches while it runs. A touch is recorded as it begins,
    /// on every window of the scene, by a recognizer that fails at once, so it never takes
    /// part in a gesture. The listener's `touches` query; debug builds only.
    @MainActor
    enum PuppetTouches {
        private static var received: [[String: Any]] = []
        private static var last = 0
        private static let kept = 64

        /// `touches {"since"?}`: how many so far as `last`, and those after `since`, in screen
        /// points (the reader's and `axe`'s units). Each read installs the recorder on any window
        /// that has none yet, so the first read arms it and a window that came since is covered.
        static func since(_ body: Data) -> [String: Any] {
            install()
            let cursor = PuppetServerContract.decodeArguments(from: body)["since"] as? Int
            return [
                "last": last,
                "touches": received.filter { ($0["id"] as? Int ?? 0) > (cursor ?? last) },
            ]
        }

        private static func install() {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            for window in scenes.flatMap(\.windows)
            where !(window.gestureRecognizers ?? []).contains(where: { $0 is Recorder }) {
                window.addGestureRecognizer(Recorder())
            }
        }

        fileprivate static func record(_ point: CGPoint) {
            last += 1
            received.append(["id": last, "x": Int(point.x.rounded()), "y": Int(point.y.rounded())])
            if received.count > kept { received.removeFirst(received.count - kept) }
        }

        private final class Recorder: UIGestureRecognizer {
            init() {
                super.init(target: nil, action: nil)
                cancelsTouchesInView = false
                delaysTouchesBegan = false
                delaysTouchesEnded = false
            }

            override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
                for touch in touches {
                    guard let window = touch.window else { continue }
                    PuppetTouches.record(
                        window.convert(
                            touch.location(in: window), to: window.screen.coordinateSpace))
                }
                state = .failed
            }
        }
    }
#endif

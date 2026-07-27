import SwiftUI
import UIKit

/// Leading-edge swipe-back for the editor screen.
///
/// The editor hides the system back button (`navigationBarBackButtonHidden`) so
/// that leaving always runs through `requestNavigation` — which drains in-flight
/// rename/move/adoption work, captures the freshest editor content, and refuses
/// to leave while a rename cannot commit. Hiding that button also disables
/// UIKit's interactive pop gesture, which is why swipe-back stopped working
/// (verified on iOS 26.5: 0/2 with the button hidden, 3/3 with it restored).
///
/// Restoring the system gesture would mean giving up the ability to VETO an exit
/// — an interactive pop cannot be refused once the finger starts it — so the
/// swipe is provided here instead and routed through the same gated verb. The
/// trade-off is a discrete (animated) pop rather than a finger-tracked parallax.
///
/// It lives in a narrow strip over the editor's leading edge so the touch never
/// reaches WebKit. That matters: WebKit's `WKDeferringGestureRecognizer`s defer
/// competing UIKit recognizers until the page's own touch handling resolves, and
/// a recognizer placed on the web view's container never fires at all.
struct EditorEdgeSwipeBack: UIViewRepresentable {
    /// Width of the touch-capturing strip. Matches the editor's text inset
    /// (`--futo-cm-pad-inline` 14px + `.cm-line`'s 6px), so it covers margin
    /// rather than tappable text.
    static let stripWidth: CGFloat = 20

    let onSwipeBack: () -> Void

    func makeUIView(context: Context) -> EdgeSwipeCaptureView {
        let view = EdgeSwipeCaptureView()
        view.onSwipeBack = onSwipeBack
        return view
    }

    func updateUIView(_ uiView: EdgeSwipeCaptureView, context: Context) {
        // Re-bind so the strip always calls the current render's closure.
        uiView.onSwipeBack = onSwipeBack
    }
}

/// Transparent strip that recognizes a rightward drag as "go back".
///
/// The strip consumes EVERY touch in its column, not only back-swipes: a clear
/// overlay hit-tests true, and hit-testing happens before there is any movement
/// to classify. So a drag started inside the strip neither scrolls the note nor
/// reaches WebKit, and a tap there does not place the caret. Keeping the strip at
/// the editor's text inset is what bounds that to margin.
final class EdgeSwipeCaptureView: UIView {
    var onSwipeBack: (() -> Void)?

    private lazy var panRecognizer = UIPanGestureRecognizer(
        target: self, action: #selector(handlePan))

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        addGestureRecognizer(panRecognizer)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    @objc private func handlePan(_ sender: UIPanGestureRecognizer) {
        guard sender.state == .ended else { return }
        guard
            isBackSwipe(
                translation: sender.translation(in: self),
                velocity: sender.velocity(in: self))
        else { return }
        onSwipeBack?()
    }

    /// UIKit consults the view that owns the recognizer, so no delegate is needed.
    /// This is the half that keeps a scroll-shaped drag out of the classifier —
    /// `isBackSwipe` on its own would accept a long diagonal drag.
    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let pan = gestureRecognizer as? UIPanGestureRecognizer else {
            return super.gestureRecognizerShouldBegin(gestureRecognizer)
        }
        return shouldBeginBackSwipe(velocity: pan.velocity(in: self))
    }
}

/// Whether a starting drag looks like a back-swipe rather than a scroll. Asked as
/// the pan begins, when UIKit has movement but little translation yet, so it reads
/// direction from velocity. A pan only begins after real movement, so this is
/// never asked about a stationary touch — which is why the classifier below never
/// sees a zero-velocity drag.
func shouldBeginBackSwipe(velocity: CGPoint) -> Bool {
    abs(velocity.x) > abs(velocity.y)
}

/// Whether a finished drag in the leading strip means "go back": far enough to
/// the right, and clearly more horizontal than vertical. A flick counts even
/// when short, which is how the system gesture feels.
func isBackSwipe(translation: CGPoint, velocity: CGPoint) -> Bool {
    guard translation.x > 0 else { return false }
    guard abs(translation.x) > abs(translation.y) else { return false }
    let draggedFarEnough = translation.x >= 60
    let flickedRight = velocity.x >= 300 && translation.x >= 20
    return draggedFarEnough || flickedRight
}

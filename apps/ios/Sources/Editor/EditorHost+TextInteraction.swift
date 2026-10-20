import UIKit
import WebKit
import os

extension EditorHost {
    func setBlockPressActive(_ active: Bool) {
        blockPressActive = active
        if !active { blockDragActive = false }  // no drag outlives its press
        applyTextInteractionLevel()
    }

    func setBlockDragActive(_ active: Bool) {
        blockDragActive = active
        applyTextInteractionLevel()
    }

    /// Applies the level the current press/drag state implies.
    ///
    /// Restores everything first and re-suspends from scratch, rather than
    /// diffing: a level change is a handful of `isEnabled` writes on a gesture
    /// that has already been cancelled, and "restore, then apply" is the only
    /// shape in which no recogniser can be left disabled by a level that no
    /// longer names it. Re-enabling mid-touch cannot resurrect a gesture — UIKit
    /// does not hand an in-flight touch sequence to a recogniser that was
    /// disabled during it.
    private func applyTextInteractionLevel() {
        let level: TextInteractionLevel =
            blockDragActive ? .full : (blockPressActive ? .press : .none)
        guard level != appliedTextInteractionLevel else { return }
        appliedTextInteractionLevel = level

        for gesture in suspendedTextGestures { gesture.isEnabled = true }
        suspendedTextGestures = []
        // `isTextInteractionEnabled` belongs to `.full` ALONE. It is a
        // page-level "this content is not selectable" preference, not a gesture
        // switch, and a tap that lands while it is off does not place a caret —
        // which is the whole affordance `.press` exists to preserve.
        webView.configuration.preferences.isTextInteractionEnabled = (level != .full)
        switch level {
        case .none:
            break
        case .press:
            suspendedTextGestures = delayedTextInteractionGestures().filter(\.isEnabled)
        case .full:
            // The navigation pop gestures too: iOS 26's content pop takes a
            // horizontal drag from ANYWHERE, so an airborne block moved sideways
            // started swiping the editor back — and the page, which never heard
            // the touch end, left the block stuck in its lifted state.
            suspendedTextGestures =
                (textInteractionGestures() + navigationPopGestures()).filter(\.isEnabled)
        }
        for gesture in suspendedTextGestures { gesture.isEnabled = false }

        let names = suspendedTextGestures.map { String(describing: type(of: $0)) }.joined(
            separator: ", ")
        let label: String
        switch level {
        case .none: label = "restored"
        case .press: label = "suspended for press"
        case .full: label = "suspended"
        }
        EditorHost.logger.info(
            "text interaction \(label, privacy: .public) (\(self.suspendedTextGestures.count, privacy: .public) gestures: \(names, privacy: .public))"
        )
    }

    /// The subset of ``textInteractionGestures()`` that recognises on a HOLD —
    /// the only ones that can take a long press away from the editor's own.
    ///
    /// Two rules, unioned, because neither alone is enough. Measured on the pool
    /// simulator (iOS 26.5), this returns exactly four of the 32 non-WebKit
    /// recognisers: `UITapAndAHalfRecognizer` and `UIVariableDelayLoupeGesture`
    /// — the two delayed TEXT gestures, matched BY NAME because neither is a
    /// `UILongPressGestureRecognizer` subclass — plus `_UIDragLiftGestureRecognizer`
    /// and `_UIDragLiftPointerGestureRecognizer`, which the long-press rule
    /// catches and which would otherwise start UIKit's own drag out of the block
    /// the editor is about to lift. Everything else stays enabled, which is why
    /// tap-to-place-caret, double-tap-to-select-a-word and its Cut/Copy/Paste
    /// callout are unaffected (all verified on the device).
    ///
    /// The name rule is therefore load-bearing and the type rule is the hedge:
    /// a future iOS that renames the loupe class but keeps it a long press is
    /// still covered. Like its superset, this reports what it found, so a future
    /// iOS that defeats both leaves a "0 gestures" line in the log rather than a
    /// silent regression.
    private func delayedTextInteractionGestures() -> [UIGestureRecognizer] {
        let named: Set<String> = ["UIVariableDelayLoupeGesture", "UITapAndAHalfRecognizer"]
        return textInteractionGestures().filter { gesture in
            gesture is UILongPressGestureRecognizer
                || named.contains(String(describing: type(of: gesture)))
        }
    }

    /// UIKit's text-interaction recognisers on the WebView's content view.
    ///
    /// WebKit installs recognisers of its own on that view — including the one
    /// that FORWARDS touch events to the page — so every WK-prefixed class is
    /// left alone: disabling those would kill the very drag this protects. What
    /// remains is UIKit's text interaction stack (the long press that magnifies,
    /// the pans that drag a caret or a selection), which is exactly what has to
    /// stand down while a block is airborne.
    ///
    /// Reached by class name rather than by a private API, and it reports what
    /// it found: a future iOS that rearranges this leaves a "0 gestures" line in
    /// the log instead of a silent regression.
    private func textInteractionGestures() -> [UIGestureRecognizer] {
        let subviews = webView.scrollView.subviews
        let content =
            subviews.first { String(describing: type(of: $0)).contains("WKContentView") }
            ?? subviews.first
        guard let content else { return [] }
        return (content.gestureRecognizers ?? []).filter { gesture in
            !String(describing: type(of: gesture)).hasPrefix("WK")
        }
    }

    /// The enclosing navigation controller's interactive pop recognisers — the
    /// leading-edge swipe, plus the full-width content swipe on iOS 26.
    private func navigationPopGestures() -> [UIGestureRecognizer] {
        var responder: UIResponder? = webView
        while let current = responder, !(current is UIViewController) { responder = current.next }
        guard let navigation = (responder as? UIViewController)?.navigationController else {
            return []
        }
        var gestures: [UIGestureRecognizer] = []
        if let edge = navigation.interactivePopGestureRecognizer { gestures.append(edge) }
        if #available(iOS 26.0, *),
            let content = navigation.interactiveContentPopGestureRecognizer
        {
            gestures.append(content)
        }
        return gestures
    }
}

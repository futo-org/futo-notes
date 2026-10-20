import SwiftUI
import UIKit

/// UIKit container installed as the editor WKWebView's keyboard
/// `inputAccessoryView` (see `futo_overrideInputAccessoryView` in
/// EditorWebView.swift). Hosting the toolbar as a real accessory view means
/// the SYSTEM owns docking and animation with the keyboard — show, hide,
/// rotation, interactive dismiss — which is exactly what the embed's
/// visualViewport-docked web toolbar had to approximate by hand.
///
/// The backdrop is the editor's own `Theme.background`, so the bar reads as the
/// bottom edge of the note with the glass capsules floating over it. The
/// system's `.keyboard` material was a near-miss of the editor colour right
/// where the two meet, and `Theme.surface` (#F2F2F2/#171717) was a visible slab.
/// Spec: docs/spec/editor.md → "Markdown toolbar".
class FutoKeyboardAccessory<Content: View>: UIInputView {
    private let hosting: UIHostingController<Content>

    @MainActor
    init(content: Content) {
        hosting = UIHostingController(rootView: content)
        // CRITICAL — the content must fill the accessory's own bounds. In the
        // keyboard's window the bottom safe-area inset is the home-indicator gap
        // (~34pt), which UIHostingController feeds into the hosted content by
        // default, leaving a dead strip below the capsules (the gap that
        // regressed in 7c43a8e). If that gap ever exceeds the intentional
        // `barHeight - capsuleHeight`, this line is the first suspect.
        hosting.safeAreaRegions = []
        super.init(
            frame: CGRect(x: 0, y: 0, width: 0, height: ToolbarMetrics.barHeight),
            inputViewStyle: .default)
        autoresizingMask = [.flexibleWidth]
        backgroundColor = UIColor(Theme.background)
        hosting.view.backgroundColor = .clear
        hosting.view.translatesAutoresizingMaskIntoConstraints = false
        addSubview(hosting.view)
        NSLayoutConstraint.activate([
            hosting.view.topAnchor.constraint(equalTo: topAnchor),
            hosting.view.bottomAnchor.constraint(equalTo: bottomAnchor),
            hosting.view.leadingAnchor.constraint(equalTo: leadingAnchor),
            hosting.view.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// The keyboard window sizes the accessory from this (width is imposed).
    override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.noIntrinsicMetric, height: ToolbarMetrics.barHeight)
    }
}

final class EditorToolbarAccessory: FutoKeyboardAccessory<EditorToolbarView> {
    private let toolbarLocalization: EditorToolbarLocalization

    @MainActor
    init(
        state: EditorToolbarState,
        localization: Localization,
        perform: @escaping (ToolbarItemSpec) -> Void
    ) {
        let toolbarLocalization = EditorToolbarLocalization(localization)
        self.toolbarLocalization = toolbarLocalization
        super.init(
            content: EditorToolbarView(
                state: state,
                toolbarLocalization: toolbarLocalization,
                perform: perform
            ))
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    @MainActor
    func updateLocalization(_ localization: Localization) {
        toolbarLocalization.update(localization)
    }
}

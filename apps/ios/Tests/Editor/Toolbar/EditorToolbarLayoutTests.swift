import SwiftUI
import Testing
import UIKit

@testable import FutoNotesNative

@MainActor
@Suite("Formatting toolbar scroll layout", .serialized)
struct EditorToolbarLayoutTests {
    @Test(
        "Crossing scroll edges preserves the viewport", arguments: [375.0, 402.0], [false, true])
    func scrollEdgesPreserveViewport(screenWidth: Double, onListLine: Bool) async throws {
        let windowScene = try #require(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        )
        let window = UIWindow(windowScene: windowScene)
        let container = UIViewController()
        let state = EditorToolbarState()
        state.onListLine = onListLine
        let toolbar = UIHostingController(
            rootView: EditorToolbarView(
                state: state,
                toolbarLocalization: EditorToolbarLocalization(
                    Localization.system(requestedLanguageTags: ["en"], regionalLanguageTag: "en-US")
                ),
                perform: { _ in }
            ).environment(\.displayScale, 3)
        )
        toolbar.safeAreaRegions = []
        window.rootViewController = container
        container.addChild(toolbar)
        container.view.addSubview(toolbar.view)
        toolbar.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            toolbar.view.leadingAnchor.constraint(equalTo: container.view.leadingAnchor),
            toolbar.view.topAnchor.constraint(
                equalTo: container.view.safeAreaLayoutGuide.topAnchor),
            toolbar.view.widthAnchor.constraint(equalToConstant: screenWidth),
            toolbar.view.heightAnchor.constraint(equalToConstant: ToolbarMetrics.barHeight),
        ])
        toolbar.didMove(toParent: container)
        window.isHidden = false
        defer {
            window.isHidden = true
            window.rootViewController = nil
        }
        container.view.layoutIfNeeded()

        let deadline = ContinuousClock.now + .seconds(3)
        var scrollView: UIScrollView?
        var stableSamples = 0
        var viewportWidth: CGFloat = 0
        while ContinuousClock.now < deadline && stableSamples < 20 {
            try await Task.sleep(for: .milliseconds(10))
            scrollView = findToolbarScrollView(in: toolbar.view)
            guard let scrollView, scrollView.contentSize.width > scrollView.bounds.width else {
                continue
            }
            let measuredWidth = scrollView.bounds.width
            stableSamples =
                measuredWidth > 0 && measuredWidth == viewportWidth ? stableSamples + 1 : 0
            viewportWidth = measuredWidth
        }
        let scrollingToolbar = try #require(scrollView)
        try #require(stableSamples == 20)
        let maximumOffset = scrollingToolbar.contentSize.width - viewportWidth
        try #require(maximumOffset > 0)
        #expect(scrollingToolbar.bounces)

        for offset in [30, maximumOffset + 20, -20, maximumOffset + 30] {
            scrollingToolbar.setContentOffset(CGPoint(x: offset, y: 0), animated: false)
            var observedWidths: Set<CGFloat> = []
            for _ in 0..<40 {
                try await Task.sleep(for: .milliseconds(10))
                observedWidths.insert(scrollingToolbar.bounds.width)
            }
            #expect(observedWidths == [viewportWidth])
        }
    }

    private func findToolbarScrollView(in view: UIView) -> UIScrollView? {
        if let scrollView = view as? UIScrollView { return scrollView }
        return view.subviews.lazy.compactMap { findToolbarScrollView(in: $0) }.first
    }
}

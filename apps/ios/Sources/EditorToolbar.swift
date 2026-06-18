import SwiftUI
import UIKit

/// Fixed metrics for the keyboard accessory toolbar, in one place so the bar
/// height can never drift between the SwiftUI view, the UIKit container frame,
/// and `intrinsicContentSize` (a mismatch there is exactly how a gap creeps
/// back in). Spec: docs/spec/editor.md → "Markdown toolbar".
enum ToolbarMetrics {
    /// The bar docks FLUSH to the top of the keyboard at this exact height —
    /// no empty band below the icons. (See EditorToolbarAccessory's
    /// safeAreaRegions note for why that flushness is fragile.)
    static let barHeight: CGFloat = 44
    /// Icon button tap target — centers in `barHeight` with ~4pt top/bottom.
    static let buttonHeight: CGFloat = 36
    /// Inter-group separator hairline height.
    static let separatorHeight: CGFloat = 20
}

/// Reactive inputs the native markdown toolbar renders from. Owned by
/// EditorHost, which updates it from bridge messages (`cursorContext`).
@MainActor
final class EditorToolbarState: ObservableObject {
    /// Cursor is on a list line — shows the Indent/Outdent items.
    @Published var onListLine = false
}

/// Native SwiftUI rendering of the shared toolbar manifest
/// (ToolbarSpec.swift — GENERATED from packages/editor/src/toolbar.ts, the
/// single source of truth for items/order/labels/visibility across all three
/// apps). Visual twin of the web toolbar (`.markdown-toolbar` in
/// components.css): a 44 pt bar of horizontally scrollable button groups with
/// hairline separators, plus a fixed dismiss chevron at the right edge.
///
/// This view owns NO editing behavior: every tap is handed to `perform`,
/// which EditorHost routes over the bridge (`FutoEditor.exec`) into the same
/// markdownToolbar.ts commands the web toolbar runs.
struct EditorToolbarView: View {
    @ObservedObject var state: EditorToolbarState
    /// Dispatch the tapped item — exec over the bridge, native image picker,
    /// or blur (dismiss).
    let perform: (ToolbarItemSpec) -> Void

    var body: some View {
        HStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    ForEach(Array(ToolbarSpec.groups.enumerated()), id: \.offset) { index, group in
                        if index > 0 {
                            separator
                        }
                        ForEach(group) { item in
                            if !item.onlyOnListLine || state.onListLine {
                                button(for: item)
                            }
                        }
                    }
                }
                .padding(.horizontal, 8)
            }
            Rectangle()
                .fill(Color(UIColor.separator))
                .frame(width: 0.5, height: ToolbarMetrics.barHeight)
            button(for: ToolbarSpec.dismiss, foreground: .secondary)
        }
        .frame(height: ToolbarMetrics.barHeight)
        .background(Theme.surface)
        .overlay(alignment: .top) {
            Rectangle().fill(Color(UIColor.separator)).frame(height: 0.5)
        }
    }

    private var separator: some View {
        Rectangle()
            .fill(Color(UIColor.separator))
            .frame(width: 1, height: ToolbarMetrics.separatorHeight)
            .padding(.horizontal, 4)
    }

    private func button(for item: ToolbarItemSpec, foreground: Color = .primary) -> some View {
        Button {
            perform(item)
        } label: {
            Image(systemName: item.sfSymbol)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(foreground)
                .frame(width: 44, height: ToolbarMetrics.buttonHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(item.label)
    }
}

/// UIKit container installed as the editor WKWebView's keyboard
/// `inputAccessoryView` (see `futo_overrideInputAccessoryView` in
/// EditorWebView.swift). Hosting the toolbar as a real accessory view means
/// the SYSTEM owns docking and animation with the keyboard — show, hide,
/// rotation, interactive dismiss — which is exactly what the embed's
/// visualViewport-docked web toolbar had to approximate by hand.
final class EditorToolbarAccessory: UIView {
    private let hosting: UIHostingController<EditorToolbarView>

    @MainActor
    init(state: EditorToolbarState, perform: @escaping (ToolbarItemSpec) -> Void) {
        hosting = UIHostingController(
            rootView: EditorToolbarView(state: state, perform: perform))
        // CRITICAL — keep the bar FLUSH to the keyboard. As a keyboard
        // inputAccessoryView this view sits in the keyboard's window, whose
        // bottom safe-area inset is the home-indicator gap (~34pt). By default
        // UIHostingController feeds that inset into the hosted SwiftUI content's
        // Environment.safeAreaInsets, so the 44pt bar lays its icons out in the
        // TOP portion and leaves a dead band below them — the exact gap that
        // regressed when the web toolbar (docked inside the webview's
        // visualViewport, naturally flush) was replaced by this native bar in
        // 7c43a8e. `safeAreaRegions = []` (iOS 16.4+; our floor is 18.0) makes
        // the content ignore all safe areas, so it fills the full 44pt and
        // docks tight to the keyboard. Do not remove without re-checking the
        // simulator with the soft keyboard up. Spec: docs/spec/editor.md.
        hosting.safeAreaRegions = []
        super.init(frame: CGRect(x: 0, y: 0, width: 0, height: ToolbarMetrics.barHeight))
        autoresizingMask = [.flexibleWidth]
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

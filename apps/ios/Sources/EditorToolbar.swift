import SwiftUI
import UIKit

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
                .frame(width: 0.5, height: 44)
            button(for: ToolbarSpec.dismiss, foreground: .secondary)
        }
        .frame(height: 44)
        .background(Theme.surface)
        .overlay(alignment: .top) {
            Rectangle().fill(Color(UIColor.separator)).frame(height: 0.5)
        }
    }

    private var separator: some View {
        Rectangle()
            .fill(Color(UIColor.separator))
            .frame(width: 1, height: 20)
            .padding(.horizontal, 4)
    }

    private func button(for item: ToolbarItemSpec, foreground: Color = .primary) -> some View {
        Button {
            perform(item)
        } label: {
            Image(systemName: item.sfSymbol)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(foreground)
                .frame(width: 44, height: 36)
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
        super.init(frame: CGRect(x: 0, y: 0, width: 0, height: 44))
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
        CGSize(width: UIView.noIntrinsicMetric, height: 44)
    }
}

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

    /// Width of the soft edge fade that eases the outer edge of the peeking
    /// icon. Kept NARROW — the real "more →" signal is the half-visible icon the
    /// snap guarantees; the fade just softens its cut edge.
    private let fadeWidth: CGFloat = 10

    /// Coordinate space anchored to the scroll CONTENT (scroll-invariant), so we
    /// can read each button's resting position regardless of scroll offset.
    private static let contentSpace = "futoToolbarContent"

    // Which edges can still scroll, driven by the live scroll geometry — decides
    // which edge fades are visible.
    @State private var canScrollLeading = false
    @State private var canScrollTrailing = false

    // ── Deterministic "peek" snapping ────────────────────────────────────────
    // The trailing cut otherwise lands at an arbitrary point on the icon grid
    // (mid-icon on some widths, in a 2pt gap on others), so a static peek is a
    // coincidence of screen width. Instead we MEASURE the laid-out button
    // positions + the natural viewport width and compute a trailing inset that
    // clips whichever button sits at the edge down to ~`peekFraction` — the same
    // half-icon peek on every iPhone size and Android density. (The Compose side
    // gets the same numbers nearly for free from `LazyListState.layoutInfo`.)
    @State private var buttonMinXs: [CGFloat] = []
    @State private var slotWidth: CGFloat = 0
    @State private var snapInset: CGFloat = 0

    var body: some View {
        HStack(spacing: 0) {
            scrollingItems
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

    /// The horizontally scrolling button groups. A measured trailing inset
    /// (`snapInset`) guarantees a half-icon peek at the trailing edge on any
    /// width; the edge fades soften that peek (and the leading edge once
    /// scrolled). Overlays sit on the ScrollView itself so they track the real
    /// (snapped) viewport edge, not the inset gap, and never intercept taps.
    private var scrollingItems: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 2) {
                ForEach(Array(ToolbarSpec.groups.enumerated()), id: \.offset) { index, group in
                    if index > 0 {
                        separator
                    }
                    ForEach(group) { item in
                        if !item.onlyOnListLine || state.onListLine {
                            button(for: item).background(buttonEdgeReader)
                        }
                    }
                }
            }
            .padding(.horizontal, 8)
            .coordinateSpace(name: Self.contentSpace)
        }
        // iOS 18+ live scroll geometry — reliable overflow detection for the
        // fades AND the source of the natural slot width. `containerSize.width`
        // is the (snapped) viewport = slot − snapInset, so `+ snapInset` recovers
        // the constant natural slot with no feedback loop. (Measuring the slot
        // via a `.background` preference does NOT work — background preferences
        // don't reach the parent's onPreferenceChange.)
        .onScrollGeometryChange(for: ToolbarScrollState.self) { geo in
            let offset = geo.contentOffset.x
            let maxOffset = max(0, geo.contentSize.width - geo.containerSize.width)
            return ToolbarScrollState(
                leading: offset > 0.5,
                trailing: offset < maxOffset - 0.5,
                containerWidth: geo.containerSize.width)
        } action: { _, s in
            canScrollLeading = s.leading
            canScrollTrailing = s.trailing
            slotWidth = s.containerWidth + snapInset
            snapInset = Self.computeSnap(xs: buttonMinXs, slot: slotWidth)
        }
        .overlay(alignment: .leading) {
            edgeFade(leading: true).opacity(canScrollLeading ? 1 : 0)
        }
        .overlay(alignment: .trailing) {
            edgeFade(leading: false).opacity(canScrollTrailing ? 1 : 0)
        }
        .animation(.easeInOut(duration: 0.15), value: canScrollLeading)
        .animation(.easeInOut(duration: 0.15), value: canScrollTrailing)
        // The snap inset narrows the visible scroll area (the freed strip is the
        // bar's own color) so the cut lands mid-icon. Applied AFTER the overlays
        // so the trailing fade rides the snapped edge.
        .padding(.trailing, snapInset)
        .onPreferenceChange(ToolbarButtonMinXKey.self) { xs in
            buttonMinXs = xs
            snapInset = Self.computeSnap(xs: xs, slot: slotWidth)
        }
    }

    /// Reports one button's resting leading-x (content space) into the shared
    /// preference array used to compute the snap.
    private var buttonEdgeReader: some View {
        GeometryReader { geo in
            Color.clear.preference(
                key: ToolbarButtonMinXKey.self,
                value: [geo.frame(in: .named(Self.contentSpace)).minX])
        }
    }

    /// Compute the trailing inset that clips the edge button to ~`peekFraction`.
    /// Pure function of the measured layout, so it's deterministic across widths
    /// and densities. When a button already straddles the edge by a sensible
    /// amount we add NO inset (zero gap); we only inset to rescue a too-thin
    /// sliver or a cut that fell in the gap between icons.
    private static func computeSnap(xs rawXs: [CGFloat], slot: CGFloat) -> CGFloat {
        let bw: CGFloat = 44  // formatting-button width (ToolbarMetrics)
        let target = bw * 0.55  // desired visible slice of the peeking icon
        let minPeek = bw * 0.30  // thinner than this reads as a stray sliver
        let maxPeek = bw * 0.85  // fuller than this reads as "not cut off"
        let xs = rawXs.sorted()
        guard slot > 1, xs.count > 1 else { return 0 }

        // No overflow → nothing to peek, no inset.
        let contentWidth = (xs.last ?? 0) + bw + 8  // + trailing pad
        guard contentWidth > slot + 1 else { return 0 }

        guard let edgeButton = xs.last(where: { $0 <= slot }) else { return 0 }
        let shown = slot - edgeButton  // how much of `edgeButton` is visible naturally
        let inset: CGFloat
        if shown < bw {
            // `edgeButton` straddles the edge — it IS the peeking icon.
            if shown >= minPeek && shown <= maxPeek {
                inset = 0  // natural peek already good — no gap
            } else if shown > maxPeek {
                inset = shown - target  // nearly whole: clip down to target
            } else if let prev = xs.last(where: { $0 + bw <= slot }) {
                inset = max(0, slot - (prev + target))  // sliver: clip the previous icon
            } else {
                inset = 0
            }
        } else {
            // `edgeButton` is fully visible and the cut fell in the gap after it
            // → clip it to the target.
            inset = max(0, slot - (edgeButton + target))
        }
        return inset
    }

    /// A soft bar-colored gradient that eases the outer edge of the partial icon
    /// peeking past this edge, so the peek looks intentional rather than hard-
    /// clipped. `leading: false` is the trailing (right) edge.
    private func edgeFade(leading: Bool) -> some View {
        LinearGradient(
            colors: [Theme.surface, Theme.surface.opacity(0)],
            startPoint: leading ? .leading : .trailing,
            endPoint: leading ? .trailing : .leading
        )
        .frame(width: fadeWidth)
        .allowsHitTesting(false)
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

// ── Scroll-affordance plumbing ────────────────────────────────────────────

/// Live scroll geometry the toolbar reacts to: which edges still have off-screen
/// content (drives the fades) and the current viewport width (drives the snap).
/// Equatable so `onScrollGeometryChange` only fires the action on real changes.
private struct ToolbarScrollState: Equatable {
    var leading: Bool
    var trailing: Bool
    var containerWidth: CGFloat
}

/// Collects each scrollable button's resting leading-x (content space) into one
/// array, used to compute the deterministic peek snap.
private struct ToolbarButtonMinXKey: PreferenceKey {
    static let defaultValue: [CGFloat] = []
    static func reduce(value: inout [CGFloat], nextValue: () -> [CGFloat]) {
        value.append(contentsOf: nextValue())
    }
}

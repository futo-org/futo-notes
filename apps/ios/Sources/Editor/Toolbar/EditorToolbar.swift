import SwiftUI
import UIKit

/// Metrics for the keyboard accessory toolbar, in one place so the height can
/// never drift between the SwiftUI view, the container frame, and
/// `intrinsicContentSize`. Spec: docs/spec/editor.md → "Markdown toolbar".
enum ToolbarMetrics {
    /// Height of the whole accessory band, deliberately TALLER than the capsule
    /// it contains — the surrounding air is what makes the capsule read as
    /// floating. `barHeight - capsuleHeight` is intentional, not a safe-area bug.
    static let barHeight: CGFloat = 56
    static let capsuleHeight: CGFloat = 40
    /// Air between the capsules and the screen edges.
    static let capsuleGap: CGFloat = 8
    static let buttonHeight: CGFloat = 36
    /// Also the unit the peek snap is computed in.
    static let buttonWidth: CGFloat = 44
    /// Inset from the capsule's rounded ends to the first/last icon.
    static let contentPad: CGFloat = 10
    static let separatorHeight: CGFloat = 20
}

private struct ToolbarIconButton: View {
    let item: ToolbarItemSpec
    let label: String
    var foreground: Color = .primary
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: item.sfSymbol)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(foreground)
                .frame(width: ToolbarMetrics.buttonWidth, height: ToolbarMetrics.buttonHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// Floating-control material: Liquid Glass on iOS 26 (what Safari's own keyboard
/// accessory controls use), the closest chrome material below it.
extension View {
    @ViewBuilder
    func futoToolbarGlass() -> some View {
        if #available(iOS 26.0, *) {
            self.glassEffect(.regular, in: .capsule)
        } else {
            self.background(.regularMaterial, in: Capsule())
        }
    }
}

private struct KeyboardDismissCapsule: View {
    let label: String
    let action: () -> Void

    var body: some View {
        ToolbarIconButton(
            item: ToolbarSpec.dismiss, label: label, foreground: .secondary, action: action
        )
        .frame(width: ToolbarMetrics.capsuleHeight, height: ToolbarMetrics.capsuleHeight)
        .clipShape(.capsule)
        .futoToolbarGlass()
    }
}

struct KeyboardDismissAccessoryView: View {
    @ObservedObject var toolbarLocalization: EditorToolbarLocalization
    let action: () -> Void

    var body: some View {
        HStack(spacing: ToolbarMetrics.capsuleGap) {
            Spacer(minLength: 0)
            KeyboardDismissCapsule(
                label: toolbarLocalization.localization.localizedText(
                    ToolbarSpec.dismiss.localizationPath),
                action: action
            )
        }
        .padding(.horizontal, ToolbarMetrics.capsuleGap)
        .frame(height: ToolbarMetrics.barHeight)
    }
}

/// Reactive inputs the native markdown toolbar renders from. Owned by
/// EditorHost, which updates it from bridge messages (`cursorContext`).
@MainActor
final class EditorToolbarState: ObservableObject {
    /// Cursor is on a list line specifically. `inContainer` is what actually
    /// gates the Indent/Outdent items now; this stays only as the fallback
    /// for a bundle old enough to have never sent `inContainer` at all.
    @Published var onListLine = false
    /// Cursor is in a list item OR a blockquote (bridge `cursorContext.
    /// inContainer`) — shows the Indent/Outdent items. `nil` means the
    /// message hasn't carried this field at all (an older bundle); the
    /// toolbar then falls back to `onListLine`, exactly today's behavior for
    /// that bundle.
    @Published var inContainer: Bool?
    /// Toolbar-manifest ids active at the cursor/selection (bridge
    /// `formatState`, Milkdown editor) — drives the Notion-style highlighted
    /// button state below. Android's
    /// counterpart is `EditorHost.activeFormats` (EditorWebView.kt).
    @Published var activeFormats: Set<String> = []
    /// Toolbar-manifest ids that are currently INERT (bridge
    /// `formatState.disabled`, Milkdown editor) — today only `undo`/`redo`
    /// with an empty prosemirror-history stack. Dims the button and blocks
    /// the tap below. Android's counterpart is `EditorHost.disabledFormats`.
    @Published var disabledFormats: Set<String> = []
}

@MainActor
final class EditorToolbarLocalization: ObservableObject {
    @Published private(set) var localization: Localization

    init(_ localization: Localization) {
        self.localization = localization
    }

    func update(_ localization: Localization) {
        guard self.localization !== localization else { return }
        self.localization = localization
    }
}

/// Native SwiftUI rendering of the shared toolbar manifest
/// (ToolbarSpec.swift — GENERATED from packages/editor/src/toolbar.ts, the
/// single source of truth for items/order/labels/visibility across all three
/// apps): horizontally scrollable button groups with hairline separators, plus
/// a fixed dismiss chevron.
///
/// This view owns NO editing behavior: every tap is handed to `perform`,
/// which EditorHost routes over the bridge (`FutoEditor.exec`) into the same
/// toolbarExec.ts commands the web toolbar runs.
struct EditorToolbarView: View {
    @Environment(\.displayScale) private var displayScale
    @ObservedObject var state: EditorToolbarState
    @ObservedObject var toolbarLocalization: EditorToolbarLocalization
    /// Dispatch the tapped item — exec over the bridge, native image picker,
    /// or blur (dismiss).
    let perform: (ToolbarItemSpec) -> Void

    /// Kept NARROW — the real "more →" signal is the half-visible icon the snap
    /// guarantees; the fade just softens its cut edge.
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

    private var snapInset: CGFloat {
        let inset = Self.computeSnap(xs: buttonMinXs, slot: slotWidth)
        return (inset * displayScale).rounded() / displayScale
    }

    /// Two floating capsules on a transparent band, matching how iOS 26 builds a
    /// keyboard accessory (verified against Safari's, simulator iOS 26.5).
    /// Deliberately NO background fill and NO top hairline: either one turns the
    /// accessory back into an opaque plank pasted onto the keyboard.
    var body: some View {
        HStack(spacing: ToolbarMetrics.capsuleGap) {
            scrollingItems
                .frame(height: ToolbarMetrics.capsuleHeight)
                .clipShape(.capsule)
                .futoToolbarGlass()
            KeyboardDismissCapsule(label: label(for: ToolbarSpec.dismiss)) {
                perform(ToolbarSpec.dismiss)
            }
        }
        .padding(.horizontal, ToolbarMetrics.capsuleGap)
        .frame(height: ToolbarMetrics.barHeight)
    }

    /// The horizontally scrolling button groups. A measured trailing inset
    /// (`snapInset`) guarantees a half-icon peek at the trailing edge on any
    /// width; the edge fades soften that peek.
    private var scrollingItems: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 2) {
                ForEach(Array(ToolbarSpec.groups.enumerated()), id: \.offset) { index, group in
                    if index > 0 {
                        separator
                    }
                    ForEach(group) { item in
                        if !item.onlyInContainer || (state.inContainer ?? state.onListLine) {
                            button(for: item).background(buttonEdgeReader)
                        }
                    }
                }
            }
            .padding(.horizontal, ToolbarMetrics.contentPad)
            .coordinateSpace(name: Self.contentSpace)
        }
        .onScrollGeometryChange(for: ToolbarScrollState.self) { geometry in
            let offset = geometry.contentOffset.x
            let maximumOffset = max(0, geometry.contentSize.width - geometry.containerSize.width)
            return ToolbarScrollState(
                leading: offset > 0.5,
                trailing: offset < maximumOffset - 0.5)
        } action: { _, scrollState in
            canScrollLeading = scrollState.leading
            canScrollTrailing = scrollState.trailing
        }
        // A MASK, not a colored overlay: a gradient of the bar's own color only
        // works when the bar HAS one, and over glass it would paint a smear.
        .mask(alignment: .leading) {
            HStack(spacing: 0) {
                edgeMask(leading: true, active: canScrollLeading)
                Rectangle().fill(.black)
                edgeMask(leading: false, active: canScrollTrailing)
            }
        }
        // Narrows the visible scroll area so the cut lands mid-icon. Applied
        // AFTER the mask so the trailing fade rides the snapped edge.
        .padding(.trailing, snapInset)
        .onGeometryChange(for: CGFloat.self) { geometry in
            geometry.size.width
        } action: { width in
            slotWidth = width
        }
        .onPreferenceChange(ToolbarButtonMinXKey.self) { buttonPositions in
            buttonMinXs = buttonPositions
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
        let bw = ToolbarMetrics.buttonWidth
        let target = bw * 0.55  // desired visible slice of the peeking icon
        let minPeek = bw * 0.30  // thinner than this reads as a stray sliver
        let maxPeek = bw * 0.85  // fuller than this reads as "not cut off"
        let xs = rawXs.sorted()
        guard slot > 1, xs.count > 1 else { return 0 }

        // No overflow → nothing to peek, no inset.
        let contentWidth = (xs.last ?? 0) + bw + ToolbarMetrics.contentPad
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

    /// One end of the scroll mask; `leading: false` is the trailing edge. Returns
    /// a gradient even when inactive so the ramp can animate in by interpolating
    /// its end color — opacity 0 on a mask HIDES content rather than revealing it.
    private func edgeMask(leading: Bool, active: Bool) -> some View {
        LinearGradient(
            colors: [active ? Color.black.opacity(0) : .black, .black],
            startPoint: leading ? .leading : .trailing,
            endPoint: leading ? .trailing : .leading
        )
        .frame(width: fadeWidth)
        .animation(.easeInOut(duration: 0.15), value: active)
    }

    private var separator: some View {
        Rectangle()
            .fill(Color(UIColor.separator))
            .frame(width: 1, height: ToolbarMetrics.separatorHeight)
            .padding(.horizontal, 4)
    }

    private func label(for item: ToolbarItemSpec) -> String {
        toolbarLocalization.localization.localizedText(item.localizationPath)
    }

    /// Notion-style active highlight (bridge `formatState`, Milkdown editor):
    /// a rounded-rect fill INSET inside the button's own frame, not
    /// the whole capsule, plus an accent-tinted icon — so it reads correctly
    /// nested inside the glass capsule background. Only `.exec` items can be
    /// active (their id is a toolbar-manifest command id); the dismiss button
    /// is rendered through this same helper but its id ("dismiss") never
    /// appears in `activeFormats`, so it is unaffected by construction.
    private func button(for item: ToolbarItemSpec, foreground: Color = .primary) -> some View {
        let isActive = state.activeFormats.contains(item.id)
        let isDisabled = state.disabledFormats.contains(item.id)
        return Button {
            perform(item)
        } label: {
            Group {
                if let text = item.text {
                    Text(text)
                } else {
                    Image(systemName: item.sfSymbol)
                }
            }
                .font(.system(size: 17, weight: .medium))
                // Theme.primary, not Color.accentColor: there is no AccentColor
                // asset, so accentColor falls back to iOS system blue — and a
                // view-root `.tint()` does not retarget an explicit
                // Color.accentColor reference.
                // The dimmed opacity is baked into the COLOR's own alpha
                // (`.opacity()` on the Color, not a separate view `.opacity()`
                // modifier) — measured on an iOS 26.5 simulator: a view-level
                // `.opacity()` on this label renders at full strength once
                // composited through the capsule's `.glassEffect()` (Liquid
                // Glass), while the identical foreground-highlight `.background`
                // wash right below renders correctly. Baking the alpha into the
                // paint color sidesteps whatever the glass material's
                // compositing does to a child view's own opacity layer.
                .foregroundStyle((isActive ? Theme.primary : foreground).opacity(isDisabled ? 0.35 : 1))
                .frame(width: ToolbarMetrics.buttonWidth, height: ToolbarMetrics.buttonHeight)
                .background {
                    if isActive {
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(Theme.primary.opacity(0.15))
                            .padding(4)
                    }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // Undo/Redo with an empty prosemirror-history stack (bridge
        // `formatState.disabled`) — blocks the tap outright, matching the
        // dimmed look above; never just a visual treatment.
        .disabled(isDisabled)
        .accessibilityLabel(label(for: item))
    }
}

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

// ── Scroll-affordance plumbing ────────────────────────────────────────────

private struct ToolbarScrollState: Equatable {
    var leading: Bool
    var trailing: Bool
}

/// Collects each scrollable button's resting leading-x (content space) into one
/// array, used to compute the deterministic peek snap.
private struct ToolbarButtonMinXKey: PreferenceKey {
    static let defaultValue: [CGFloat] = []
    static func reduce(value: inout [CGFloat], nextValue: () -> [CGFloat]) {
        value.append(contentsOf: nextValue())
    }
}

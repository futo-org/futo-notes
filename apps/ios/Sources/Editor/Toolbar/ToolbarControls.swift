import SwiftUI

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

struct KeyboardDismissCapsule: View {
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

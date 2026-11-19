import SwiftUI
import UIKit

/// Keeps a bottom-of-layout view above the software keyboard's real top edge, measured from the
/// keyboard frame UIKit reports instead of trusting SwiftUI's keyboard safe area alone.
///
/// On iOS 26 that safe area comes out short while the find field takes focus: the keyboard
/// settles at 335pt but the safe area reads 279pt (the editor toolbar accessory's 56pt removal
/// applied twice) and nothing recomputes it until a keystroke. The find bar then opened hidden
/// behind the keyboard's suggestion strip. The view keeps its place in the layout; this adds
/// only the shortfall between where SwiftUI put its bottom and where UIKit says the keyboard
/// starts, so a correct safe area (iOS 27) adds nothing and a hidden, hardware or floating
/// keyboard adds nothing either.
///
/// Apply it to a view that is always in the hierarchy: `active` says whether it currently needs
/// the clearance, so the keyboard frame is tracked while it is hidden and a bar that opens
/// onto a keyboard that is already up is docked at once.
private struct KeyboardClearance: ViewModifier {
    let active: Bool

    /// Bottom of the layout slot, in `.global` (window) space. Measured outside the padding
    /// this modifier adds: the slot's bottom edge does not move with the view's height.
    @State private var slotBottom: CGFloat = 0
    /// Top of a keyboard docked to the window's bottom edge, or nil when none is.
    @State private var keyboardTop: CGFloat?

    func body(content: Content) -> some View {
        content
            .padding(.bottom, active ? shortfall : 0)
            .onGeometryChange(for: CGFloat.self) { proxy in
                proxy.frame(in: .global).maxY
            } action: { bottom in
                slotBottom = bottom
            }
            .onReceive(
                NotificationCenter.default
                    .publisher(for: UIResponder.keyboardWillChangeFrameNotification)
                    .merge(
                        with: NotificationCenter.default
                            .publisher(for: UIResponder.keyboardDidChangeFrameNotification))
            ) { note in
                let top = Self.dockedKeyboardTop(note)
                let duration =
                    note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double
                    ?? 0
                withAnimation(duration > 0 ? .easeOut(duration: duration) : nil) {
                    keyboardTop = top
                }
            }
    }

    private var shortfall: CGFloat {
        keyboardTop.map { max(0, slotBottom - $0) } ?? 0
    }

    /// The keyboard's top edge in the key window's coordinates, or nil when the keyboard is
    /// hidden, attached to hardware, or floating (iPad): none of which covers the window's
    /// bottom edge.
    private static func dockedKeyboardTop(_ note: Notification) -> CGFloat? {
        guard
            let screenFrame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey]
                as? CGRect
        else { return nil }
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        guard
            let window = scenes.first(where: { $0.activationState == .foregroundActive })?
                .keyWindow ?? scenes.compactMap(\.keyWindow).first
        else { return nil }
        let frame = window.convert(screenFrame, from: window.screen.coordinateSpace)
        let bounds = window.bounds
        guard frame.minY < bounds.maxY, frame.maxY >= bounds.maxY - 1 else { return nil }
        return frame.minY
    }
}

extension View {
    /// See `KeyboardClearance`.
    func clearsKeyboard(active: Bool) -> some View {
        modifier(KeyboardClearance(active: active))
    }
}

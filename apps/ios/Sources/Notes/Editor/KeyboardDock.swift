import SwiftUI
import UIKit

/// Holds `content` against the top of the software keyboard, measured from the
/// keyboard frame UIKit reports instead of SwiftUI's keyboard safe area.
///
/// On iOS 26 that safe area comes out short when the find field takes focus:
/// the keyboard settles at 335pt while the safe area reads 279pt, the editor
/// toolbar accessory's 56pt removal applied twice. The find bar therefore
/// opened behind the keyboard's suggestion strip and only moved above it on the
/// first keystroke. UIKit's keyboard-frame notifications carry the right frame
/// on every iOS version, so this overlay ignores the keyboard safe area and
/// lifts itself by exactly the keyboard's overlap with it.
struct KeyboardDock<Content: View>: View {
    @ViewBuilder let content: Content

    /// Bottom of the area this dock may fill, in `.global` (window) space.
    @State private var regionBottom: CGFloat = 0
    /// Top of a keyboard docked to the window's bottom edge, or nil when none is.
    @State private var keyboardTop: CGFloat?

    var body: some View {
        content
            .padding(.bottom, keyboardTop.map { max(0, regionBottom - $0) } ?? 0)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            .onGeometryChange(for: CGFloat.self) { proxy in
                proxy.frame(in: .global).maxY
            } action: { bottom in
                regionBottom = bottom
            }
            .ignoresSafeArea(.keyboard, edges: .bottom)
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

    /// The keyboard's top edge in the key window's coordinates, or nil when the
    /// keyboard is hidden, attached to hardware, or floating (iPad) — none of
    /// which covers the window's bottom edge.
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

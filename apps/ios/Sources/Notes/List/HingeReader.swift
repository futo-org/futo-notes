import SwiftUI

/// Reports whether the device's hinge is flat. A foldable iPhone held partially open has
/// a crease across the inner screen; flat, closed, or on a device with no hinge, there is
/// nothing to avoid. UIKit exposes the hinge's status and angle but not where it sits, so
/// the shell takes the window's middle.
struct HingeReader: UIViewRepresentable {
    @Binding var isFlat: Bool

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.isUserInteractionEnabled = false
        #if FUTO_DEBUG_BUILD
            if Self.debugPartiallyOpen { return view }
        #endif
        // UIHingeInteraction is in the iOS 27.1 SDK (Swift 6.4); older toolchains build without it.
        #if compiler(>=6.4)
            if #available(iOS 27.1, *) {
                view.addInteraction(
                    UIHingeInteraction { _, update in
                        let flat = update.hinge.map { $0.status != .partiallyOpen } ?? true
                        DispatchQueue.main.async { if isFlat != flat { isFlat = flat } }
                    })
            }
        #endif
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {}

    /// Where a shell's hinge state starts: flat, unless a debug build was told otherwise.
    static var initiallyFlat: Bool {
        #if FUTO_DEBUG_BUILD
            !debugPartiallyOpen
        #else
            true
        #endif
    }

    #if FUTO_DEBUG_BUILD
        /// `-FUTODebugHinge partiallyOpen`: the simulator cannot half-fold a hinge.
        static var debugPartiallyOpen: Bool {
            UserDefaults.standard.string(forKey: "FUTODebugHinge") == "partiallyOpen"
        }
    #endif
}

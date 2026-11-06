#if FUTO_DEBUG_BUILD
    import SwiftUI
    import UIKit

    /// Hosts the controller's text view in SwiftUI. The view itself is the controller's; this
    /// only mounts it and carries the theme.
    struct TextFirstEditorRepresentable: UIViewRepresentable {
        let controller: TextFirstEditorController
        let theme: String

        func makeUIView(context: Context) -> TextFirstTextView {
            controller.setTheme(theme)
            return controller.textView
        }

        func updateUIView(_ uiView: TextFirstTextView, context: Context) {
            controller.setTheme(theme)
        }
    }
#endif

#if FUTO_DEBUG_BUILD
    import SwiftUI
    import UIKit

    /// Hosts the controller's text view in SwiftUI. The view itself is the controller's; this
    /// only mounts it and carries the theme.
    struct TextFirstEditorRepresentable: UIViewRepresentable {
        let controller: TextFirstEditorController
        let theme: String

        func makeUIView(context: Context) -> TextFirstEditorContainer {
            controller.setTheme(theme)
            return TextFirstEditorContainer(textView: controller.textView)
        }

        func updateUIView(_ uiView: TextFirstEditorContainer, context: Context) {
            controller.setTheme(theme)
        }
    }

    /// Keeps the text view's own frame still while SwiftUI shrinks and grows this view for the
    /// keyboard; what the keyboard covers becomes the text view's bottom inset instead.
    ///
    /// A frame change on a TextKit 2 text view ends in `-[_UITextContainerView
    /// _ensureLayoutForCappedSize]`, which lays the note out from its first line to the viewport
    /// (some 13,000 paragraphs in a 20,000-line note: 0.5 to 2.4 s of the simulator's main thread)
    /// and re-bases the height estimate under the reader. Half a second after the keyboard rose the
    /// view jumped by tens of thousands of points, leaving the caret off screen. An inset change
    /// lays nothing out.
    final class TextFirstEditorContainer: UIView {
        let textView: TextFirstTextView
        /// The tallest this view has been at its current width: the height the text view keeps.
        private var fullHeight: CGFloat = 0
        private var width: CGFloat = 0

        init(textView: TextFirstTextView) {
            self.textView = textView
            super.init(frame: .zero)
            clipsToBounds = true
            addSubview(textView)
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

        override func layoutSubviews() {
            super.layoutSubviews()
            if bounds.width != width {
                width = bounds.width
                fullHeight = bounds.height
            } else {
                fullHeight = max(fullHeight, bounds.height)
            }
            let frame = CGRect(x: 0, y: 0, width: bounds.width, height: fullHeight)
            if textView.frame != frame { textView.frame = frame }
            let covered = fullHeight - bounds.height
            if textView.contentInset.bottom != covered {
                textView.contentInset.bottom = covered
                textView.verticalScrollIndicatorInsets.bottom = covered
            }
        }
    }
#endif

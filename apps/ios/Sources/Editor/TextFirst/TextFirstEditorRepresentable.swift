import SwiftUI
import UIKit

/// Hosts the controller's text view in SwiftUI. The view itself is the controller's; this
/// only mounts it and carries the theme.
struct TextFirstEditorRepresentable: UIViewRepresentable {
    let controller: TextFirstEditorController
    let theme: String
    /// What the views stacked under the editor (completions, find bar) cover.
    let belowCover: CGFloat

    func makeUIView(context: Context) -> TextFirstEditorContainer {
        controller.setTheme(theme)
        let container = TextFirstEditorContainer(textView: controller.textView)
        container.belowCover = belowCover
        return container
    }

    func updateUIView(_ uiView: TextFirstEditorContainer, context: Context) {
        controller.setTheme(theme)
        uiView.belowCover = belowCover
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
    /// This view's top, in window space, when it was last `fullHeight` tall.
    private var fullTop: CGFloat = 0
    private var width: CGFloat = 0
    /// From the keyboard's will-hide to its did-hide.
    private var keyboardHiding = false
    /// What the views stacked under this one (completions, find bar) cover now.
    var belowCover: CGFloat = 0 {
        didSet { if belowCover != oldValue, keyboardHiding { setNeedsLayout() } }
    }

    init(textView: TextFirstTextView) {
        self.textView = textView
        super.init(frame: .zero)
        clipsToBounds = true
        addSubview(textView)
        let center = NotificationCenter.default
        center.addObserver(
            self, selector: #selector(keyboardWillHide),
            name: UIResponder.keyboardWillHideNotification, object: nil)
        center.addObserver(
            self, selector: #selector(keyboardDidHide),
            name: UIResponder.keyboardDidHideNotification, object: nil)
    }

    @objc private func keyboardWillHide() {
        keyboardHiding = true
        setNeedsLayout()
    }

    @objc private func keyboardDidHide() {
        keyboardHiding = false
        setNeedsLayout()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func layoutSubviews() {
        super.layoutSubviews()
        if bounds.width != width {
            // TextKit 2 before iOS 27 re-lays out on the new width and leaves the reader far
            // from their line in a long note (#388): hold the top line across the change.
            let held = width > 0 ? textView.controller?.captureScrollAnchor() : nil
            width = bounds.width
            fullHeight = bounds.height
            applyFrame()
            textView.controller?.restoreScrollAnchor(held, widthChange: true)
        } else {
            fullHeight = max(fullHeight, bounds.height)
        }
        applyFrame()
        let top = convert(CGPoint.zero, to: nil).y
        if bounds.height >= fullHeight { fullTop = top }
        var covered = fullHeight - bounds.height
        if keyboardHiding {
            // While the keyboard hides, SwiftUI still sizes this view short by the toolbar
            // accessory's height until did-hide (~0.4 s): the note settled a toolbar-height too
            // high, then jumped down. What the keyboard covered is already gone; what the views
            // under this one cover, and the banners above that pushed it down, are not.
            covered = min(covered, belowCover + max(0, top - fullTop))
        }
        if textView.contentInset.bottom != covered {
            let rising = covered > textView.contentInset.bottom
            textView.contentInset.bottom = covered
            textView.verticalScrollIndicatorInsets.bottom = covered
            // the keyboard came up over an open cell that was in view without it.
            if rising { textView.controller?.cellEditor?.scrollCellIntoView() }
        }
    }

    private func applyFrame() {
        let frame = CGRect(x: 0, y: 0, width: bounds.width, height: fullHeight)
        if textView.frame != frame { textView.frame = frame }
    }
}

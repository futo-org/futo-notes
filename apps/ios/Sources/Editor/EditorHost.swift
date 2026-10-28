import SwiftUI
import UIKit
import WebKit
import os

/// Owns the single, app-lifetime editor WKWebView. Pre-warmed once so it has
/// already reached `ready` (bundle parsed, Milkdown mounted) by the time the
/// user opens a note. Per-note bindings (onChange/autoFocus) are
/// swapped on each [attach]; the bridge forwards to whatever is currently bound.
///
/// Must be constructed on the main thread (WKWebView requirement). `@MainActor`
/// because it owns UIKit/WebKit state and the message handler runs on main.
@MainActor
final class EditorHost: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    static let shared = EditorHost()
    nonisolated static let logger = Logger(subsystem: "com.futo.notes", category: "editor-webview")

    /// Left/right inset of the note body, sent to the bundle in the host
    /// config.
    nonisolated static let contentPaddingInlinePx = 14

    let mailbox = EditorMailbox()
    var desiredNoteId = ""
    var lastPushedNoteId: String?
    var pushed: [String: String] = [:]
    var externalPushed: [String: String] = [:]
    var adoptions: [String: (Bool) -> Void] = [:]
    var onDocumentLoaded: (String) -> Void = { _ in }
    var onFocusChange: (Bool) -> Void = { _ in }
    var onOpenNote: ((String) -> Void)? = nil
    var onFindMatches: ((FindMatchesReport) -> Void)? = nil
    var autoFocus = false

    /// The bundle has applied this shell's host config and the note is on
    /// screen (the `initialized` message) — not merely that the page loaded.
    var isReady = false

    // What this shell last SENT the bundle, so a SwiftUI update per keystroke
    // does not become an evaluateJavaScript per keystroke carrying the whole
    // note universe (M5). Purely a transport gate — what counts as a change,
    // and what the editor does about it, is decided in
    // packages/editor/src/hostBoot.ts. Android keeps the same gate for the same
    // reason; the right way to retire both is to stop calling the setters from
    // a view update, not to delete the compares.
    var currentTheme: String?
    var desiredTheme = "light"
    var currentLanguageTag: String?
    var desiredLocalization = Localization.system()
    var desiredLanguageTag: String { desiredLocalization.effectiveLanguage.tag }
    var desiredContent = ""
    /// The last content we pushed in, so we don't re-push our own echoes.
    var lastPushedContent: String?
    /// The note universe JSON (setNotes) to (re)push when ready. The JSON string
    /// doubles as the dedupe signature — identical pushes are skipped.
    var desiredNotesJson: String?
    var lastPushedNotesJson: String?

    /// Incremented per attach; detach only clears if its token is still current.
    var generation = 0
    /// The navigation route's note id of the attached editor once its body has
    /// been read from disk and handed to it. Nil between notes. A rename in place
    /// leaves it, as it leaves the route. The debug puppet listener waits on it
    /// before writing into a just-opened note; nothing else reads it.
    var loadedNoteId: String?
    let completionQueue = EditorCompletionQueue()

    /// Reactive inputs for the NATIVE markdown toolbar (bridge v3
    /// cursorContext drives Indent/Outdent visibility).
    let toolbarState = EditorToolbarState()

    /// iOS long-press mobile block-drag haptics (bridge 'haptic'). Separate
    /// generators (not one reused instance) so `.medium` (lift) and `.light`
    /// (drop) each stay primed for their own style; `prepare()` ahead of
    /// `impactOccurred()` minimizes the click's latency, re-primed immediately
    /// after firing for the next lift/drop.
    let liftHapticFeedback = UIImpactFeedbackGenerator(style: .medium)
    let dropHapticFeedback = UIImpactFeedbackGenerator(style: .light)
    /// The tick as the drop indicator passes each boundary. A SELECTION
    /// generator rather than a third impact: this is UIKit's "the value under
    /// your finger changed" feedback — the same one a picker wheel uses — and it
    /// is deliberately lighter than the lift and the drop so a drag reads as
    /// one pickup, a run of ticks, and one landing.
    let moveHapticFeedback = UISelectionFeedbackGenerator()
    /// The native toolbar, installed as the keyboard's inputAccessoryView via
    /// futo_overrideInputAccessoryView. Lazy: the closure captures self.
    lazy var toolbarAccessory = EditorToolbarAccessory(
        state: toolbarState,
        localization: desiredLocalization
    ) { [weak self] item in
        self?.performToolbarAction(item)
    }

    let editorFileURL: URL?
    let webView: WKWebView
    #if DEBUG
        let benchProbe = BlockDragBenchProbe()
    #endif

    private override init() {
        // Force the keyboard to appear when an EMPTY contenteditable is focused
        // (WKWebView otherwise suppresses it — "can't type in a new note").
        WKWebView.futo_allowKeyboardWithoutUserInteraction()

        let controller = WKUserContentController()
        let config = WKWebViewConfiguration()
        config.userContentController = controller
        // Local images: ![](photo.png) resolves through the custom futo-asset
        // scheme, served from the vault root (path-traversal- and image-
        // extension-guarded — see FutoAssetSchemeHandler). Must be registered
        // BEFORE the WKWebView is created.
        config.setURLSchemeHandler(
            FutoAssetSchemeHandler(), forURLScheme: FutoAssetSchemeHandler.scheme)

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.isOpaque = false
        wv.backgroundColor = .clear
        wv.scrollView.backgroundColor = .clear
        // The page owns ALL scrolling (the editor's .ProseMirror scrolls internally;
        // html/body are overflow:hidden — see editor.html). The OUTER
        // UIScrollView must therefore never move: when it can, WebKit's keyboard
        // "reveal focused element" behavior pans it, after which touch and layout
        // coordinates disagree and every tap places the caret ABOVE the touched
        // point by the pan amount.
        wv.scrollView.isScrollEnabled = false
        wv.scrollView.bounces = false
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        wv.scrollView.automaticallyAdjustsScrollIndicatorInsets = false
        #if DEBUG
            if #available(iOS 16.4, *) {
                wv.isInspectable = true
            }
        #endif
        self.editorFileURL = Bundle.main.url(
            forResource: "editor",
            withExtension: "html"
        )
        self.webView = wv
        super.init()

        controller.add(self, name: "futoBridge")
        #if DEBUG
            if BlockDragBenchProbe.isEnabled {
                controller.add(benchProbe, name: BlockDragBenchProbe.handlerName)
            }
        #endif
        wv.navigationDelegate = self

        loadEditor()

        // Prime both haptic generators ahead of the first lift/drop — see
        // the property doc comment.
        liftHapticFeedback.prepare()
        dropHapticFeedback.prepare()
        moveHapticFeedback.prepare()
    }

    /// How much of WKWebView's text interaction is currently stood down.
    ///
    /// TWO levels, because the two things the editor reports are not equally
    /// safe to act on. A PRESS is only a maybe — it can still turn out to be a
    /// tap that places a caret or a scroll — so only the gestures that need a
    /// HOLD to recognize stand down, and the page stays fully selectable. A
    /// DRAG is committed, so the whole stack goes, preference included.
    enum TextInteractionLevel {
        /// Nothing suspended.
        case none
        /// A finger is down on a block: the DELAYED gestures only (the loupe
        /// long press, tap-and-a-half select, UIKit's own drag lift). The tap
        /// and pan recognizers — caret placement, double-tap word select,
        /// selection-handle adjustment — are deliberately left alone.
        case press
        /// A block is airborne: every non-WebKit recognizer on the content
        /// view, plus `isTextInteractionEnabled`.
        case full
    }

    /// Recognizers this suspended, so exactly the ones that were turned off get
    /// turned back on.
    var suspendedTextGestures: [UIGestureRecognizer] = []
    var appliedTextInteractionLevel: TextInteractionLevel = .none
    /// The two halves of the editor's report, tracked separately: the drag ends
    /// one message before the press does, and the level is recomputed from both
    /// rather than toggled, so neither message can strand the other's work.
    var blockPressActive = false
    var blockDragActive = false

    /// Load the bundled editor into the WebView. Used at init and again to
    /// recover after the WebKit content process terminates.
    ///
    /// Load from a file:// URL (not loadHTMLString with a nil baseURL): the
    /// bundle is a single self-contained file whose JS is an inline
    /// `<script type="module">`. Module scripts refuse to execute under the
    /// opaque/null origin that `baseURL: nil` produces, leaving the editor
    /// blank. A file:// origin is non-opaque, so the inline module runs.
    func loadEditor() {
        // A page that goes away mid-gesture can never post its `blockPress
        // false`, and the WebView outlives the page (this is also the
        // WebContent-crash recovery path). Text interaction the editor borrowed
        // comes back here rather than staying suspended for the rest of the
        // session.
        setBlockPressActive(false)
        if let url = editorFileURL {
            #if FUTO_DEBUG_BUILD
                var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
                components.queryItems = [URLQueryItem(name: "test", value: nil)]
                webView.loadFileURL(
                    components.url!, allowingReadAccessTo: url.deletingLastPathComponent())
            #else
                webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
            #endif
        } else {
            let message = desiredLocalization.localizedText("editor.ios.bundleMissing")
            webView.loadHTMLString(
                "<html><body><p>\(htmlEscaped(message))</p></body></html>",
                baseURL: nil
            )
        }
    }

    private func htmlEscaped(_ text: String) -> String {
        text
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }

    /// Kick off WebView creation + bundle load early (e.g. app start) so the
    /// editor is warm before the first note-open. Must run on the main thread.
    static func prewarm() {
        _ = EditorHost.shared
    }

    /// An autofocus that arrived before the web view had a window.
    var pendingAutoFocus = false
}

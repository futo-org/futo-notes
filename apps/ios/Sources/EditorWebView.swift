import SwiftUI
import WebKit
import ObjectiveC
import ObjectiveC.runtime
import os

/// SwiftUI wrapper around a single, app-lifetime WKWebView that hosts the
/// bundled markdown editor — the iOS counterpart of Android's `EditorHost`
/// (apps/android/.../ui/EditorWebView.kt).
///
/// The WebView is NOT created per note-open. A cold WKWebView boot (WebKit
/// process start + parse/exec of the editor bundle + CodeMirror mount) costs
/// ~0.2–0.5 s, which used to land on the navigation critical path: the native
/// SwiftUI chrome painted instantly while the editor lagged behind. Instead a
/// single [EditorHost] owns ONE WKWebView, pre-warmed once at app start
/// ([EditorHost.prewarm]). Opening a note reparents that already-`ready`
/// WebView into the current view and resets content with a single `setContent`
/// — no boot on the open path. Reuse is safe because the nav stack never holds
/// two editors at once (List/Search ↔ Editor only), so exactly one note binds
/// the shared WebView at a time.
///
/// The page exposes `window.FutoEditor` (setContent/getContent/focus/setTheme)
/// and posts messages to the native handler named exactly "futoBridge":
///   { type: 'ready' }
///   { type: 'change', content: <markdown> }
///   { type: 'focus', focused: <bool> }
struct EditorWebView: UIViewRepresentable {
    /// Markdown to push into the editor once it is ready.
    let content: String
    /// "light" or "dark".
    let theme: String
    /// Focus the editor + raise the keyboard once ready (brand-new note only).
    var autoFocus: Bool = false
    /// Called when the web page posts a content change.
    let onChange: (String) -> Void
    /// Called once when the editor signals 'ready'.
    var onReady: (() -> Void)? = nil

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        let host = EditorHost.shared
        // Bind this note's callbacks to the shared host for the lifetime of this
        // view. A generation token guards against a future nav change attaching a
        // new note before this view's dismantle runs.
        context.coordinator.token = host.attach(
            autoFocus: autoFocus, onChange: onChange, onReady: onReady)
        // Detach the shared WebView from any previous holder, then adopt it.
        host.webView.removeFromSuperview()
        return host.webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        // Keep the host's desired state in sync so post-ready pushes use current
        // values, and push live updates (theme/external content adopt) if ready.
        EditorHost.shared.updateDesired(content: content, theme: theme)
    }

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        // Unbind this view's callbacks unless a newer attach already took over.
        // The shared WebView itself is NEVER torn down — it lives for the whole
        // app so the next note-open reuses it.
        EditorHost.shared.detach(coordinator.token)
    }

    final class Coordinator {
        var token: Int = 0
    }
}

/// Owns the single, app-lifetime editor WKWebView. Pre-warmed once so it has
/// already reached `ready` (bundle parsed, CodeMirror mounted) by the time the
/// user opens a note. Per-note bindings (onChange/onReady/autoFocus) are
/// swapped on each [attach]; the bridge forwards to whatever is currently bound.
///
/// Must be constructed on the main thread (WKWebView requirement). `@MainActor`
/// because it owns UIKit/WebKit state and the message handler runs on main.
@MainActor
final class EditorHost: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    static let shared = EditorHost()

    private var onChange: (String) -> Void = { _ in }
    private var onReady: (() -> Void)? = nil
    private var autoFocus = false

    private var isReady = false
    private var currentTheme: String?
    private var desiredTheme = "light"
    private var desiredContent = ""
    /// The last content we pushed in, so we don't re-push our own echoes.
    private var lastPushedContent: String?

    /// Incremented per attach; detach only clears if its token is still current.
    private var generation = 0

    let webView: WKWebView

    private override init() {
        // Force the keyboard to appear when an EMPTY contenteditable is focused
        // (WKWebView otherwise suppresses it — "can't type in a new note").
        WKWebView.futo_allowKeyboardWithoutUserInteraction()

        let controller = WKUserContentController()
        let config = WKWebViewConfiguration()
        config.userContentController = controller

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.isOpaque = false
        wv.backgroundColor = .clear
        wv.scrollView.backgroundColor = .clear
        // The page owns ALL scrolling (CM6's .cm-scroller scrolls internally;
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
        self.webView = wv
        super.init()

        controller.add(self, name: "futoBridge")
        wv.navigationDelegate = self

        // Load from a file:// URL (not loadHTMLString with a nil baseURL): the
        // bundle is a single self-contained file whose JS is an inline
        // `<script type="module">`. Module scripts refuse to execute under the
        // opaque/null origin that `baseURL: nil` produces, leaving the editor
        // blank. A file:// origin is non-opaque, so the inline module runs.
        if let url = Bundle.main.url(forResource: "editor", withExtension: "html") {
            wv.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        } else {
            wv.loadHTMLString(
                "<html><body><p>editor.html not found in bundle</p></body></html>",
                baseURL: nil
            )
        }
    }

    /// Kick off WebView creation + bundle load early (e.g. app start) so the
    /// editor is warm before the first note-open. Must run on the main thread.
    static func prewarm() {
        _ = EditorHost.shared
    }

    /// Bind a note's callbacks. Returns a token for the matching [detach]. If the
    /// editor is already warm, push the desired content/theme + fire onReady (and
    /// focus) now so the "ready for this note" contract holds for reused opens.
    func attach(
        autoFocus: Bool,
        onChange: @escaping (String) -> Void,
        onReady: (() -> Void)?
    ) -> Int {
        self.onChange = onChange
        self.onReady = onReady
        self.autoFocus = autoFocus
        // A reused (already-ready) WebView still holds the PREVIOUS note's text;
        // force a fresh push by clearing the dedup marker so the new note's
        // content always lands even if the host was last showing it.
        lastPushedContent = nil
        if isReady {
            pushTheme(desiredTheme)
            pushContent(desiredContent)
            onReady?()
            if autoFocus { startAutoFocus() }
        }
        generation += 1
        return generation
    }

    /// Unbind, unless a newer [attach] has already taken over.
    func detach(_ token: Int) {
        guard token == generation else { return }
        onChange = { _ in }
        onReady = nil
        autoFocus = false
    }

    func updateDesired(content: String, theme: String) {
        desiredContent = content
        desiredTheme = theme
        guard isReady else { return }
        if theme != currentTheme { pushTheme(theme) }
        if content != lastPushedContent { pushContent(content) }
    }

    // MARK: WKScriptMessageHandler

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }

        switch type {
        case "ready":
            isReady = true
            pushTheme(desiredTheme)
            pushContent(desiredContent)
            onReady?()
            if autoFocus { startAutoFocus() }
        case "change":
            if let content = body["content"] as? String {
                lastPushedContent = content
                onChange(content)
            }
        case "focus":
            // The private WKContentView exists once focused; strip its
            // input-accessory bar again here in case it appeared late.
            if (body["focused"] as? Bool) == true {
                webView.futo_removeInputAccessoryView()
            }
        default:
            break
        }
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Remove the keyboard's prev/next/Done accessory bar so the plain
        // keyboard shows. The WKContentView is in the scroll view by now.
        webView.futo_removeInputAccessoryView()
    }

    // MARK: JS bridge

    /// Brand-new note: focus the editor and raise the keyboard. Flip the global
    /// "force keyboard" gate ON only for this programmatic focus, then back OFF,
    /// so opening an EXISTING note never pops the keyboard.
    private func startAutoFocus() {
        futoForceKeyboardOnFocus = true
        webView.evaluateJavaScript(
            "window.FutoEditor && window.FutoEditor.focus();", completionHandler: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            futoForceKeyboardOnFocus = false
        }
    }

    /// Encode an arbitrary Swift string as a safe JS string literal.
    private func jsLiteral(_ s: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [s], options: []))
            ?? Data("[\"\"]".utf8)
        var json = String(data: data, encoding: .utf8) ?? "[\"\"]"
        // Strip the surrounding [ ] to get just the quoted string literal.
        json = json.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        return json
    }

    private func pushContent(_ content: String) {
        lastPushedContent = content
        let js = "window.FutoEditor && window.FutoEditor.setContent(\(jsLiteral(content)));"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    private func pushTheme(_ theme: String) {
        currentTheme = theme
        let js = "window.FutoEditor && window.FutoEditor.setTheme(\(jsLiteral(theme)));"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }
}

// MARK: - Input-accessory removal

/// Cache of runtime-generated subclasses, keyed by the base class name, so we
/// only build each one once. Single-threaded use (main actor / UI) only.
private nonisolated(unsafe) var futoNoAccessoryClasses: [String: AnyClass] = [:]

/// When true, the focus swizzle forces the keyboard up even for programmatic /
/// empty-contenteditable focus. We only flip it on for the brand-new-note
/// auto-focus, so opening an existing note never pops the keyboard.
nonisolated(unsafe) var futoForceKeyboardOnFocus = false

extension WKWebView {
    /// Removes the keyboard input-accessory bar (the prev / next / Done toolbar
    /// shown above the keyboard for web content). There is no public API for
    /// this: the bar belongs to the private `WKContentView` that is the actual
    /// first responder, not to the `WKWebView`. We give that view a runtime
    /// subclass whose `inputAccessoryView` getter returns nil.
    func futo_removeInputAccessoryView() {
        guard let contentView = scrollView.subviews.first(where: {
            let name = String(describing: type(of: $0))
            return name.hasPrefix("WKContentView") || name.contains("ContentView")
        }) else { return }

        let baseClass: AnyClass = type(of: contentView)
        let newName = "FutoNoAccessory_" + NSStringFromClass(baseClass)

        if let cached = futoNoAccessoryClasses[newName] {
            object_setClass(contentView, cached)
            return
        }
        guard let subclass = objc_allocateClassPair(baseClass, newName, 0) else { return }
        let sel = #selector(getter: UIResponder.inputAccessoryView)
        let block: @convention(block) (AnyObject) -> UIView? = { _ in nil }
        let imp = imp_implementationWithBlock(block)
        // method_getTypeEncoding returns UnsafePointer<CChar>?; pass it through
        // directly (a Swift String literal auto-bridges for the fallback).
        if let method = class_getInstanceMethod(baseClass, sel),
           let types = method_getTypeEncoding(method) {
            class_addMethod(subclass, sel, imp, types)
        } else {
            class_addMethod(subclass, sel, imp, "@@:")
        }
        objc_registerClassPair(subclass)
        futoNoAccessoryClasses[newName] = subclass
        object_setClass(contentView, subclass)
    }
}

// MARK: - keyboardDisplayRequiresUserAction = false

/// Forces the iOS software keyboard to appear when a contenteditable / input
/// inside a WKWebView is focused — including the EMPTY-contenteditable case
/// (a brand-new note) that iOS otherwise suppresses. No public API exists; we
/// swizzle the private WKContentView focus method to force its
/// `userIsInteracting` argument to true. Selector verified stable iOS 13–26:
///   _elementDidFocus:userIsInteracting:blurPreviousNode:activityStateChanges:userObject:
extension WKWebView {
    private static let keyboardLog =
        Logger(subsystem: "com.futo.notes.native", category: "wkwebview-keyboard")

    /// Runs exactly once per process (replaces the IMP on the shared
    /// WKContentView class, not per instance).
    private static let installKeyboardFix: Void = {
        guard let contentViewClass = NSClassFromString("WKContentView") else {
            WKWebView.keyboardLog.error("WKContentView not found; keyboard fix skipped")
            return
        }

        // ABI of _elementDidFocus:userIsInteracting:blurPreviousNode:activityStateChanges:userObject:
        //   arg0 information          const FocusedElementInformation&  -> UnsafeRawPointer
        //   arg1 userIsInteracting    BOOL                              -> Bool  (forced true)
        //   arg2 blurPreviousNode     BOOL                              -> Bool
        //   arg3 activityStateChanges OptionSet<ActivityState>          -> UInt
        //   arg4 userObject           NSObject<NSSecureCoding>*         -> Any?
        typealias FocusIMP13 = @convention(c)
            (Any, Selector, UnsafeRawPointer, Bool, Bool, UInt, Any?) -> Void
        typealias FocusBlock13 = @convention(block)
            (Any, UnsafeRawPointer, Bool, Bool, UInt, Any?) -> Void

        let selector = sel_getUid(
            "_elementDidFocus:userIsInteracting:blurPreviousNode:activityStateChanges:userObject:")
        guard let method = class_getInstanceMethod(contentViewClass, selector) else {
            WKWebView.keyboardLog.error("focus selector not found; keyboard fix NOT applied")
            return
        }
        let original = method_getImplementation(method)
        let orig = unsafeBitCast(original, to: FocusIMP13.self)
        let block: FocusBlock13 = { me, arg0, userInteracting, blurPrev, activity, userObject in
            // Force the keyboard ONLY when we intend to (new-note auto-focus);
            // otherwise pass the real userIsInteracting through, so opening an
            // existing note does not pop the keyboard.
            orig(me, selector, arg0, futoForceKeyboardOnFocus || userInteracting,
                 blurPrev, activity, userObject)
        }
        method_setImplementation(method, imp_implementationWithBlock(block))
        WKWebView.keyboardLog.info("keyboard fix installed")
    }()

    /// Call once, early. Safe to call repeatedly — the work runs exactly once.
    static func futo_allowKeyboardWithoutUserInteraction() {
        _ = WKWebView.installKeyboardFix
    }
}

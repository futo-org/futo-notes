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
/// The page exposes `window.FutoEditor` (setContent/getContent/focus/setTheme
/// plus the v2 additions setNotes/applyExternalContent/insertImage/
/// setImageBaseUrl and the v3 additions exec/blur/setNativeToolbar) and posts
/// messages to the native handler named exactly "futoBridge":
///   { type: 'ready' }
///   { type: 'change', content: <markdown> }
///   { type: 'focus', focused: <bool> }
///   { type: 'openNote', id: <resolved note id> }
///   { type: 'pickImage', source: 'camera' | 'library' }
///   { type: 'cursorContext', onListLine: <bool> }
///
/// The markdown toolbar is NATIVE on iOS: EditorHost installs
/// EditorToolbarAccessory as the keyboard's inputAccessoryView (so it docks
/// and animates with the keyboard), tells the embed to suppress its web
/// toolbar (setNativeToolbar), and dispatches taps back over the bridge —
/// `exec(<manifest id>)` runs the SHARED markdownToolbar.ts command, so the
/// editing behavior is identical to the web/Android toolbar by construction.
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
    /// Called when the user taps a RESOLVED wikilink (bridge 'openNote');
    /// receives the resolved note id (path sans .md).
    var onOpenNote: ((String) -> Void)? = nil

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        let host = EditorHost.shared
        // Bind this note's callbacks to the shared host for the lifetime of this
        // view. A generation token guards against a future nav change attaching a
        // new note before this view's dismantle runs.
        context.coordinator.token = host.attach(
            autoFocus: autoFocus, onChange: onChange, onReady: onReady,
            onOpenNote: onOpenNote)
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
    nonisolated static let logger = Logger(subsystem: "com.futo.notes", category: "editor-webview")

    private var onChange: (String) -> Void = { _ in }
    private var onReady: (() -> Void)? = nil
    private var onOpenNote: ((String) -> Void)? = nil
    private var autoFocus = false

    private var isReady = false
    private var currentTheme: String?
    private var desiredTheme = "light"
    private var desiredContent = ""
    /// The last content we pushed in, so we don't re-push our own echoes.
    private var lastPushedContent: String?
    /// The note universe JSON (setNotes) to (re)push when ready. The JSON string
    /// doubles as the dedupe signature — identical pushes are skipped.
    private var desiredNotesJson: String?
    private var lastPushedNotesJson: String?

    /// Incremented per attach; detach only clears if its token is still current.
    private var generation = 0

    /// Reactive inputs for the NATIVE markdown toolbar (bridge v3
    /// cursorContext drives Indent/Outdent visibility).
    let toolbarState = EditorToolbarState()
    /// The native toolbar, installed as the keyboard's inputAccessoryView via
    /// futo_overrideInputAccessoryView. Lazy: the closure captures self.
    private lazy var toolbarAccessory = EditorToolbarAccessory(
        state: toolbarState
    ) { [weak self] item in
        self?.performToolbarAction(item)
    }

    let webView: WKWebView

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

        loadEditor()
    }

    /// Load the bundled editor into the WebView. Used at init and again to
    /// recover after the WebKit content process terminates.
    ///
    /// Load from a file:// URL (not loadHTMLString with a nil baseURL): the
    /// bundle is a single self-contained file whose JS is an inline
    /// `<script type="module">`. Module scripts refuse to execute under the
    /// opaque/null origin that `baseURL: nil` produces, leaving the editor
    /// blank. A file:// origin is non-opaque, so the inline module runs.
    private func loadEditor() {
        if let url = Bundle.main.url(forResource: "editor", withExtension: "html") {
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        } else {
            webView.loadHTMLString(
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
        onReady: (() -> Void)?,
        onOpenNote: ((String) -> Void)? = nil
    ) -> Int {
        self.onChange = onChange
        self.onReady = onReady
        self.onOpenNote = onOpenNote
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
        onOpenNote = nil
        autoFocus = false
    }

    func updateDesired(content: String, theme: String) {
        desiredContent = content
        desiredTheme = theme
        guard isReady else { return }
        if theme != currentTheme { pushTheme(theme) }
        if content != lastPushedContent { pushContent(content) }
    }

    /// Host → editor: the note universe ([{id,title,modifiedMs,tags}] JSON) for
    /// suffix-resolution, wikilink autocomplete, and decoration refresh. Deduped
    /// on the JSON string so repeated `$notes` publishes don't spam
    /// evaluateJavaScript; the page persists across note-opens, so the universe
    /// only needs re-pushing when it actually changes (or after a fresh ready).
    func setNotes(_ json: String) {
        desiredNotesJson = json
        guard isReady, json != lastPushedNotesJson else { return }
        pushNotes(json)
    }

    /// Selection/scroll-preserving, history-suppressed adopt of an external
    /// (remote-sync) update of the OPEN note. Sets the dedupe marker FIRST so
    /// the SwiftUI state change that follows (updateDesired with the same
    /// content) is a no-op instead of a caret-resetting setContent.
    func applyExternal(content: String) {
        desiredContent = content
        guard isReady else { return }
        lastPushedContent = content
        let js = "window.FutoEditor && window.FutoEditor.applyExternalContent(\(jsLiteral(content)));"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    /// Host → editor: insert `![](filename)\n` at the cursor. Called after a
    /// picked image has been saved into the vault root.
    func insertImage(_ filename: String) {
        let js = "window.FutoEditor && window.FutoEditor.insertImage(\(jsLiteral(filename)));"
        webView.evaluateJavaScript(js, completionHandler: nil)
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
            // Local image filenames in ![](f) resolve through the native
            // futo-asset scheme (served from the vault root).
            pushImageBaseUrl()
            // The toolbar is native (keyboard accessory) — tell the embed to
            // keep its web toolbar hidden. Per page load, so re-sent on every
            // fresh 'ready'.
            pushNativeToolbar()
            pushContent(desiredContent)
            if let json = desiredNotesJson { pushNotes(json) }
            onReady?()
            if autoFocus { startAutoFocus() }
        case "change":
            if let content = body["content"] as? String {
                lastPushedContent = content
                onChange(content)
            }
        case "focus":
            // The private WKContentView exists once focused; re-apply the
            // accessory override here in case it appeared late.
            if (body["focused"] as? Bool) == true {
                webView.futo_overrideInputAccessoryView(toolbarAccessory)
            }
        case "cursorContext":
            // Deduped by the embed — drives Indent/Outdent visibility in the
            // native toolbar.
            toolbarState.onListLine = (body["onListLine"] as? Bool) ?? false
        case "openNote":
            // User tapped a RESOLVED wikilink — the bound note view navigates.
            if let id = body["id"] as? String {
                onOpenNote?(id)
            }
        case "pickImage":
            // Toolbar image button: open the native picker, save the bytes into
            // the vault root, then hand the filename back via insertImage.
            presentImagePicker(source: (body["source"] as? String) ?? "library")
        case "saveImageData":
            // Clipboard image paste: the embed read the pasted bytes (base64).
            // Decode OFF the main thread — EditorHost is @MainActor, so a
            // multi-MB base64 string decoded inline would block the UI / risk
            // the watchdog (Android decodes on Dispatchers.IO). Then save via
            // the SAME path as the picker and hand the filename back.
            if let base64 = body["data"] as? String,
               let ext = body["ext"] as? String {
                Task { @MainActor in
                    guard let data = await Task.detached(priority: .userInitiated) {
                        Data(base64Encoded: base64)
                    }.value else { return }
                    guard let filename = await VaultImages.save(
                        data: data, preferredExtension: ext) else { return }
                    self.insertImage(filename)
                }
            }
        default:
            break
        }
    }

    /// Bridge 'pickImage': camera or library picker (camera falls back to the
    /// library on devices/simulators without one), save into the vault root
    /// honoring the shared image-extension rules, then insertImage(filename).
    private func presentImagePicker(source: String) {
        ImagePicker.present(source: source) { [weak self] data, ext in
            guard let self, let data else { return }
            Task { @MainActor in
                guard let filename = await VaultImages.save(
                    data: data, preferredExtension: ext) else { return }
                self.insertImage(filename)
            }
        }
    }

    /// Native toolbar tap → bridge. `exec` runs the shared markdownToolbar.ts
    /// command for the item's manifest id; pickImage opens the native picker
    /// (same path the web toolbar's bridge message takes); dismiss blurs the
    /// editor through the bridge so the page's focus state stays truthful
    /// (the resulting keyboard drop hides this accessory too).
    private func performToolbarAction(_ item: ToolbarItemSpec) {
        switch item.action {
        case .exec:
            let js = "window.FutoEditor && window.FutoEditor.exec(\(jsLiteral(item.id)));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        case .pickImage(let source):
            presentImagePicker(source: source)
        case .dismiss:
            webView.evaluateJavaScript(
                "window.FutoEditor && window.FutoEditor.blur();", completionHandler: nil)
        }
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Replace the keyboard's default prev/next/Done accessory bar with the
        // native markdown toolbar. The WKContentView is in the scroll view by
        // now.
        webView.futo_overrideInputAccessoryView(toolbarAccessory)
    }

    /// The WebKit content process died (OOM / jetsam under memory pressure).
    /// The editor — the app's core surface — is now blank with no automatic
    /// recovery. Reload it: the fresh 'ready' re-pushes theme/content/notes
    /// (all retained in `desired*`), so the open note's text is restored
    /// without the user noticing more than a brief flash. Without this handler
    /// the editor stays permanently blank after a backgrounded jetsam.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        EditorHost.logger.error("WebContent process terminated; reloading editor")
        isReady = false
        currentTheme = nil
        lastPushedContent = nil
        lastPushedNotesJson = nil
        loadEditor()
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

    private func pushNotes(_ json: String) {
        lastPushedNotesJson = json
        let js = "window.FutoEditor && window.FutoEditor.setNotes(\(jsLiteral(json)));"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    private func pushImageBaseUrl() {
        let js = "window.FutoEditor && window.FutoEditor.setImageBaseUrl(\(jsLiteral("futo-asset:///")));"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    private func pushNativeToolbar() {
        webView.evaluateJavaScript(
            "window.FutoEditor && window.FutoEditor.setNativeToolbar(true);",
            completionHandler: nil)
    }
}

// MARK: - Input-accessory override

/// Cache of runtime-generated subclasses, keyed by the base class name, so we
/// only build each one once. Single-threaded use (main actor / UI) only.
private nonisolated(unsafe) var futoAccessoryClasses: [String: AnyClass] = [:]

/// The view the swizzled `inputAccessoryView` getter returns. nil = no bar at
/// all (the original behavior of this hack, which only STRIPPED Apple's
/// prev/next/Done bar); EditorHost sets the native markdown toolbar here.
/// One global is enough: the app has exactly one editor WKWebView (EditorHost
/// is a singleton).
private nonisolated(unsafe) var futoAccessoryOverrideView: UIView?

/// When true, the focus swizzle forces the keyboard up even for programmatic /
/// empty-contenteditable focus. We only flip it on for the brand-new-note
/// auto-focus, so opening an existing note never pops the keyboard.
nonisolated(unsafe) var futoForceKeyboardOnFocus = false

extension WKWebView {
    /// Replaces the keyboard input-accessory bar (the prev / next / Done
    /// toolbar shown above the keyboard for web content) with `view` — or
    /// with nothing when `view` is nil. There is no public API for this: the
    /// bar belongs to the private `WKContentView` that is the actual first
    /// responder, not to the `WKWebView`. We give that view a runtime
    /// subclass whose `inputAccessoryView` getter returns our override.
    func futo_overrideInputAccessoryView(_ view: UIView?) {
        futoAccessoryOverrideView = view
        guard let contentView = scrollView.subviews.first(where: {
            let name = String(describing: type(of: $0))
            return name.hasPrefix("WKContentView") || name.contains("ContentView")
        }) else { return }

        defer {
            // If the keyboard is already up, make it re-query the accessory.
            if contentView.isFirstResponder { contentView.reloadInputViews() }
        }

        let baseClass: AnyClass = type(of: contentView)
        let newName = "FutoAccessoryOverride_" + NSStringFromClass(baseClass)

        if let cached = futoAccessoryClasses[newName] {
            object_setClass(contentView, cached)
            return
        }
        guard let subclass = objc_allocateClassPair(baseClass, newName, 0) else { return }
        let sel = #selector(getter: UIResponder.inputAccessoryView)
        let block: @convention(block) (AnyObject) -> UIView? = { _ in
            futoAccessoryOverrideView
        }
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
        futoAccessoryClasses[newName] = subclass
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
        Logger(subsystem: "com.futo.notes", category: "wkwebview-keyboard")

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

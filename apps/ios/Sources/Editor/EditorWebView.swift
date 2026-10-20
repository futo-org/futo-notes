import SwiftUI
import UIKit
import WebKit

func shouldDeliverEditorCompletion(
    capturedGeneration: Int,
    currentGeneration: Int
) -> Bool {
    capturedGeneration == currentGeneration
}

func editorGenerationAfterDetach(
    detachedToken: Int,
    currentGeneration: Int
) -> Int {
    detachedToken == currentGeneration ? currentGeneration + 1 : currentGeneration
}

struct FindMatchesReport: Equatable {
    let query: String
    let label: String

    init?(body: [String: Any]) {
        guard let query = body["query"] as? String,
            let label = body["label"] as? String
        else { return nil }
        self.query = query
        self.label = label
    }
}

enum EditorNavigationDecision: Equatable {
    case allow
    case openExternally(URL)
    case deny
}

func editorNavigationDecision(
    for url: URL?,
    isMainFrame: Bool,
    permittedFileURL: URL?
) -> EditorNavigationDecision {
    guard isMainFrame else { return .allow }
    guard let url, let scheme = url.scheme?.lowercased() else { return .deny }

    switch scheme {
    case "file":
        guard let permittedFileURL,
            permittedFileURL.isFileURL,
            url.standardizedFileURL.path == permittedFileURL.standardizedFileURL.path
        else { return .deny }
        return .allow
    case "about" where url.absoluteString.caseInsensitiveCompare("about:blank") == .orderedSame:
        // The missing-bundle fallback uses loadHTMLString with a nil base URL.
        return .allow
    case "http", "https", "mailto", "tel":
        return .openExternally(url)
    default:
        return .deny
    }
}

@MainActor
final class EditorCompletionQueue {
    private var tail: Task<Void, Never>?
    private var admission = 0

    func enqueue(_ operation: @escaping @MainActor () async -> Void) {
        let previous = tail
        admission += 1
        tail = Task { @MainActor in
            await previous?.value
            await operation()
        }
    }

    func waitForCurrent() async {
        while true {
            let admitted = admission
            await tail?.value
            if admitted == admission { return }
        }
    }
}

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
/// — no boot on the open path.
///
/// Following a wikilink PUSHES a new editor onto the NavigationStack (so Back
/// returns to the note you came from), and SwiftUI keeps every stacked editor
/// alive. So more than one [NoteEditorView] can exist at once, but there is
/// still exactly ONE WebView: each [EditorWebView] hosts it inside a plain
/// container and re-adopts it (reparent + rebind + re-push its note's content)
/// whenever it (re)enters the window — see [EditorContainerView.onEnterWindow]
/// and [Coordinator.adopt]. Off-screen editors never touch the shared WebView
/// (their reparent + external-sync adopt are gated on visibility), so the
/// visible editor always owns it.
///
/// The page exposes `window.FutoEditor` — the v7 `initialize(configJson)` boot
/// entry point plus setContent/flush/focus/setTheme, the v2 additions
/// setNotes/applyExternalContent/insertImage/setImageBaseUrl and the v3
/// additions exec/blur/setNativeToolbar — and posts messages to the native
/// handler named exactly "futoBridge":
///   { type: 'ready' }                                          → send config
///   { type: 'initialized', version }                           (v7)
///   { type: 'bridgeVersionMismatch', hostVersion, bundleVersion } (v7)
///   { type: 'change', noteId, generation, content: <markdown> }
///   { type: 'focus', focused: <bool> }
///   { type: 'openNote', id: <resolved note id> }
///   { type: 'openUrl', url: <external url> }                    (v6)
///   { type: 'pickImage', source: 'camera' | 'library' }
///   { type: 'cursorContext', onListLine: <bool>, inContainer?: <bool> }
///   { type: 'saveImageData', data: <base64>, ext: <string> }   (v4)
///   { type: 'pasteClipboardImage' }                            (v5)
///   { type: 'formatState', active: [<toolbar id>], disabled: [<toolbar id>] }
///     (Milkdown editor, unversioned — see bridge.ts's BRIDGE_VERSION doc
///     comment; drives toolbar highlighting AND the Undo/Redo grey-out below)
///   { type: 'haptic', kind: 'lift' | 'move' | 'drop' } (Milkdown editor, unversioned —
///     the long-press block-drag path both native shells mount; drives the
///     impact and selection feedback generators below)
///   { type: 'blockDrag', active: <bool> }              (Milkdown editor, unversioned —
///     same path; suspends WKWebView's text interaction so the OS magnifier
///     stays out of the drag. Android needs no equivalent — see bridge.ts)
///   { type: 'blockPress', pressed: <bool> }            (Milkdown editor, unversioned —
///     the same path's TOUCH-DOWN half; stands the delayed text interaction
///     down before it can win the race the lift used to have to)
///
/// The markdown toolbar is NATIVE on iOS: EditorHost installs
/// FutoKeyboardAccessory as the keyboard's inputAccessoryView (so it docks
/// and animates with the keyboard), tells the embed to suppress its web
/// toolbar (setNativeToolbar), and dispatches taps back over the bridge —
/// `exec(<manifest id>)` runs the SHARED markdownToolbar.ts command, so the
/// editing behavior is identical to the web/Android toolbar by construction.
struct EditorWebView: UIViewRepresentable {
    let noteId: String
    /// Markdown to push into the editor once it is ready.
    let content: String
    /// "light" or "dark".
    let theme: String
    let localization: Localization
    /// Focus the editor + raise the keyboard once ready (brand-new note only).
    var autoFocus: Bool = false
    /// Called when the web page posts a content change.
    let onChange: (String) -> Void
    var onDocumentLoaded: (String) -> Void = { _ in }
    /// Reports the embed's authoritative body-focus state. Open-note
    /// reconciliation owns the defer-until-blur duty at this one seam.
    var onFocusChange: (Bool) -> Void = { _ in }
    /// Called when the user taps a RESOLVED wikilink (bridge 'openNote');
    /// receives the resolved note id (path sans .md).
    var onOpenNote: ((String) -> Void)? = nil
    /// Receives the engine-authored native find-bar state verbatim.
    var onFindMatches: ((FindMatchesReport) -> Void)? = nil
    /// Receives this view's host generation so imperative calls can reject a stale screen.
    var attachment: EditorAttachmentSlot? = nil

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> EditorContainerView {
        let coord = context.coordinator
        coord.sync(
            noteId: noteId, content: content, theme: theme, localization: localization,
            autoFocus: autoFocus,
            onChange: onChange, onDocumentLoaded: onDocumentLoaded, onFocusChange: onFocusChange,
            onOpenNote: onOpenNote,
            onFindMatches: onFindMatches, attachment: attachment)
        let container = EditorContainerView()
        container.backgroundColor = .clear
        coord.container = container
        // Re-adopt the shared WebView whenever this editor (re)enters the window
        // — e.g. Back after a wikilink push, where the shared WebView is
        // currently hosted by the note we navigated away from.
        container.onEnterWindow = { [weak coord] in
            coord?.adoptIfNeeded()
            EditorHost.shared.runPendingAutoFocus()
        }
        coord.adopt()
        return container
    }

    func updateUIView(_ uiView: EditorContainerView, context: Context) {
        let coord = context.coordinator
        coord.sync(
            noteId: noteId, content: content, theme: theme, localization: localization,
            autoFocus: autoFocus,
            onChange: onChange, onDocumentLoaded: onDocumentLoaded, onFocusChange: onFocusChange,
            onOpenNote: onOpenNote,
            onFindMatches: onFindMatches, attachment: attachment)
        // Only the VISIBLE editor drives the shared WebView. Gating on `window`
        // stops an off-screen editor (covered by a pushed one) from stealing the
        // WebView or pushing its content over the visible note — e.g. when a
        // live-sync `$notes` publish re-renders a stacked-but-hidden editor.
        guard uiView.window != nil else { return }
        coord.adoptIfNeeded()
        EditorHost.shared.updateDesired(
            noteId: noteId, content: content,
            theme: theme,
            localization: localization
        )
    }

    static func dismantleUIView(_ uiView: EditorContainerView, coordinator: Coordinator) {
        // Unbind this view's callbacks unless a newer attach already took over.
        // The shared WebView itself is NEVER torn down — it lives for the whole
        // app so the next note-open reuses it.
        //
        // NOTHING ELSE MAY GO HERE THAT WRITES SwiftUI STATE. The attachment token
        // used to be cleared on this line, and that write aborted the app on every
        // exit from a note: AttributeGraph is invalidating the subgraph that owns
        // the `@State` while this runs, so setting it trips Swift's exclusivity
        // check ("Fatal access conflict detected"). Nor may the slot be cleared:
        // a system pop dismantles BEFORE the editor's onDisappear runs its exit,
        // and that exit still uses the popped note's attachment identity.
        // `detach` is what makes a clear redundant — the host's generation is
        // monotonic and never equal to a detached token again, so a stale token
        // can no longer satisfy `isCurrentAttachment`.
        EditorHost.shared.detach(coordinator.token)
    }

    /// Per-view binding state. The container's `onEnterWindow` re-adopts using
    /// the LATEST values (refreshed each `updateUIView`), so a re-adopt on Back
    /// rebinds the correct note's callbacks + content, not a stale snapshot.
    /// `@MainActor` because it drives `EditorHost.shared` (main-actor-isolated)
    /// synchronously from `adopt()`/`adoptIfNeeded()`, including from
    /// `EditorContainerView.onEnterWindow`, a UIKit callback that always runs
    /// on main.
    @MainActor
    final class Coordinator {
        var token: Int = 0
        weak var container: EditorContainerView?
        private var didInitialAdopt = false

        private var noteId = ""
        private var content = ""
        private var theme = "light"
        private var localization = Localization.system()
        private var autoFocus = false
        private var onChange: (String) -> Void = { _ in }
        private var onDocumentLoaded: (String) -> Void = { _ in }
        private var onFocusChange: (Bool) -> Void = { _ in }
        private var onOpenNote: ((String) -> Void)?
        private var onFindMatches: ((FindMatchesReport) -> Void)?
        private var attachment: EditorAttachmentSlot?

        func sync(
            noteId: String, content: String, theme: String, localization: Localization,
            autoFocus: Bool,
            onChange: @escaping (String) -> Void,
            onDocumentLoaded: @escaping (String) -> Void,
            onFocusChange: @escaping (Bool) -> Void,
            onOpenNote: ((String) -> Void)?,
            onFindMatches: ((FindMatchesReport) -> Void)?,
            attachment: EditorAttachmentSlot?
        ) {
            self.noteId = noteId
            self.content = content
            self.theme = theme
            self.localization = localization
            self.autoFocus = autoFocus
            self.onChange = onChange
            self.onDocumentLoaded = onDocumentLoaded
            if token != 0 {
                EditorHost.shared.rebind(
                    token, noteId: noteId, onChange: onChange, onDocumentLoaded: onDocumentLoaded)
            }
            self.onFocusChange = onFocusChange
            self.onOpenNote = onOpenNote
            self.onFindMatches = onFindMatches
            self.attachment = attachment
        }

        /// Reclaim the shared WebView for this container unless it already hosts it.
        func adoptIfNeeded() {
            guard let container, EditorHost.shared.webView.superview !== container else { return }
            adopt()
        }

        func adopt() {
            guard let container else { return }
            let host = EditorHost.shared
            host.webView.removeFromSuperview()
            host.webView.frame = container.bounds
            host.webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            container.addSubview(host.webView)
            host.updateDesired(
                noteId: noteId, content: content, theme: theme, localization: localization)
            // autoFocus fires only on the FIRST adopt: a re-adopt on Back must
            // not re-pop the keyboard.
            host.detach(token)
            token = host.attach(
                noteId: noteId,
                autoFocus: didInitialAdopt ? false : autoFocus,
                onChange: onChange,
                onDocumentLoaded: onDocumentLoaded,
                onFocusChange: onFocusChange,
                onOpenNote: onOpenNote,
                onFindMatches: onFindMatches)
            attachment?.token = token
            didInitialAdopt = true
        }
    }
}

@MainActor
final class EditorAttachmentSlot {
    var token: Int?

    /// `nonisolated` so a SwiftUI view can hold one in `@State`.
    nonisolated init() {}
}

/// Hosts the single shared editor WKWebView. Reports when it becomes visible
/// (added to a window) so its [EditorWebView] can re-adopt the shared WebView —
/// which is one instance migrating between the stacked editors (List ↔ Editor ↔
/// wikilinked Editor …). `didMoveToWindow` fires with a non-nil window on show
/// and a nil window on cover/pop, so the re-adopt is driven exactly on show.
final class EditorContainerView: UIView {
    var onEnterWindow: (() -> Void)?
    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { onEnterWindow?() }
    }
}

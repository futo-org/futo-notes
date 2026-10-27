import SwiftUI

/// The native counterpart of `registerPuppetVerbs` (src/app/puppet/puppetRegistry.ts): a
/// SwiftUI screen declares the verbs for its OWN controls while it is on screen, and the
/// `futo-puppet` listener runs them without knowing anything about the view's `@State`.
///
/// Why it has to exist: the shell's navigation verbs (`OpenNote`, `GoBack`) live in
/// `PuppetServer` because they are the navigation stack's, and the editor's text verbs live
/// in the webview. Everything in between — the title field, the find bar, a list's New note
/// and New folder, the folder dialogs and move sheets — is SwiftUI state inside one view,
/// reachable from nowhere else. Without a registry those controls could never be verbs, which
/// is the whole reason a driver does worse on a phone than on the desktop. A menu iOS presents
/// itself (a `.contextMenu`, `.swipeActions`, a `Menu {}`) cannot be opened or read by the
/// app, so it has no verbs: a driver opens it with a real touch and taps one of its items.
///
/// A verb runs on the main actor, like the tap it stands in for, and is the closure of the
/// view's latest render, so its props are current (`PuppetVerbScope`).
@MainActor
final class PuppetVerbs {
    static let shared = PuppetVerbs()

    struct Verb {
        let name: String
        let required: [String]
        let optional: [String]
        /// Argument names whose schema type is `integer` rather than `string` — the
        /// desktop verb of the same name takes a number, and a driver reads the schema.
        let integers: [String]
        /// Argument names whose schema type is `boolean` (a checkbox's state).
        let booleans: [String]
        /// Not input a person makes (an instant scroll): `actions` says so, as desktop's does.
        let convenience: Bool
        /// The catalog keys of the labels of the controls this verb stands for, so a row reads
        /// `→ Verb` and `just check-puppet-verbs` holds every labelled control to a verb.
        let controls: [String]
        /// Optional arguments that take the next steps for the agent: argument name → the
        /// verbs a person takes after this one, in order, each with its arguments, where `"$"`
        /// (as a step's verb or an argument's value) stands for the value the agent gave. The
        /// CLI expands them — it runs this verb, then the steps — so `run` ignores a shortcut
        /// argument and must not act on one. Same contract as Android's `PuppetVerb`.
        let shortcuts: [String: [(verb: String, arguments: [String: String])]]
        let run: ([String: Any]) async throws -> [String: Any]

        init(
            _ name: String,
            required: [String] = [],
            optional: [String] = [],
            integers: [String] = [],
            booleans: [String] = [],
            convenience: Bool = false,
            controls: [String] = [],
            shortcuts: [String: [(verb: String, arguments: [String: String])]] = [:],
            run: @escaping ([String: Any]) async throws -> [String: Any]
        ) {
            precondition(
                shortcuts.keys.allSatisfy(optional.contains),
                "\(name): a shortcut argument must be optional")
            self.name = name
            self.required = required
            self.optional = optional
            self.integers = integers
            self.booleans = booleans
            self.convenience = convenience
            self.controls = controls
            self.shortcuts = shortcuts
            self.run = run
        }

        /// A verb that is a plain tap: no arguments, nothing to report.
        init(_ name: String, controls: [String] = [], tap: @escaping () async throws -> Void) {
            self.init(name, controls: controls) { _ in
                try await tap()
                return [:]
            }
        }
    }

    #if DEBUG
        /// Scopes in the order they appeared, so the screen on top registers last and wins
        /// a name the screen beneath it also has. A scope holds the CLOSURE, not its result:
        /// it is asked afresh for every `actions` and every `do`, so a screen returns what a
        /// user could do right now — the find bar's verbs only while the bar is up — and the
        /// menu cannot disagree with the refusal. Same contract as `registerPuppetVerbs` in
        /// src/app/puppet/puppetRegistry.ts.
        private var scopes: [(token: UUID, modal: Bool, verbs: () -> [Verb])] = []

        /// What the app last put on the clipboard and how many copies it has made: `state`'s
        /// `copied`, so a receipt says what was copied without reading the pasteboard, which
        /// holds whatever the user copied anywhere else (a simulator shares the Mac's).
        private(set) var copied: (count: Int, text: String)?

        func recordCopy(_ text: String) {
            copied = ((copied?.count ?? 0) + 1, text)
        }

        /// What the app last handed the OS to open — a page, mail, Settings — and how many:
        /// `state`'s `opened`, so a receipt names it.
        private(set) var opened: (count: Int, url: String)?

        func recordOpen(_ url: String) {
            opened = ((opened?.count ?? 0) + 1, url)
        }

        /// The note the open editor is showing RIGHT NOW. The navigation stack keeps the id
        /// the push carried, so after a rename in place it names a note that no longer
        /// exists; this is what the editor itself holds. Nil when no editor is up.
        var openNote: String?

        /// A modal sheet (the crash report) is all a user can reach while it is up. It counts
        /// while it has verbs: answered, it offers none through its dismiss animation.
        var all: [Verb] {
            let modal = modalVerbs
            return modal.isEmpty ? scopes.flatMap { $0.verbs() } : modal
        }

        /// A modal sheet is up, so nothing beneath it — the shell's verbs included — is on screen.
        var modalUp: Bool { !modalVerbs.isEmpty }

        private var modalVerbs: [Verb] { scopes.filter(\.modal).flatMap { $0.verbs() } }

        func register(_ token: UUID, modal: Bool = false, _ verbs: @escaping () -> [Verb]) {
            unregister(token)
            scopes.append((token, modal, verbs))
        }

        func unregister(_ token: UUID) {
            scopes.removeAll { $0.token == token }
        }

        func verb(named name: String) -> Verb? {
            all.last { $0.name == name }
        }
    #else
        // A shipped build carries the call sites and holds nothing, exactly as the release
        // `PuppetServer` does on Android.
        var all: [Verb] { [] }
        var modalUp: Bool { false }
        var openNote: String? {
            get { nil }
            set {}
        }
        var copied: (count: Int, text: String)? { nil }
        func recordCopy(_ text: String) {}
        var opened: (count: Int, url: String)? { nil }
        func recordOpen(_ url: String) {}
        func register(_ token: UUID, modal: Bool = false, _ verbs: @escaping () -> [Verb]) {}
        func unregister(_ token: UUID) {}
        func verb(named name: String) -> Verb? { nil }
    #endif
}

extension PuppetVerbs {
    /// Starts an act that waits on something outside the app — a browser sign-in, a
    /// pairing code's five minutes — and answers once it has begun. The listener runs one
    /// command at a time, so awaiting the wait would hold every verb behind it, its own
    /// Cancel included.
    static func begin(_ act: @escaping @MainActor () async -> Void) async -> [String: Any] {
        Task { @MainActor in await act() }
        await Task.yield()
        return ["started": true]
    }
}

/// A verb saying no: the same status and sentence the listener's own refusals use.
/// Lives outside `#if DEBUG` because a release build still compiles the closures.
struct PuppetVerbRefusal: Error {
    let status: Int
    let message: String

    init(_ status: Int, _ message: String) {
        self.status = status
        self.message = message
    }
}

extension View {
    /// The verbs this screen's controls are, for as long as it is on screen. A `modal` scope is
    /// a sheet over everything: while it is up, its verbs are the only ones on offer.
    func puppetVerbs(modal: Bool = false, _ verbs: @escaping () -> [PuppetVerbs.Verb]) -> some View
    {
        modifier(PuppetVerbScope(modal: modal, verbs: verbs))
    }
}

private struct PuppetVerbScope: ViewModifier {
    let modal: Bool
    let verbs: () -> [PuppetVerbs.Verb]
    @State private var token = UUID()
    @State private var latest = Latest()

    /// The closure from the view's latest render. The one `onAppear` registers would hold
    /// the props of the FIRST render — a `busy` that never clears — so the registry asks
    /// this box instead, as Android's `rememberUpdatedState` does.
    private final class Latest {
        var verbs: () -> [PuppetVerbs.Verb] = { [] }
    }

    func body(content: Content) -> some View {
        latest.verbs = verbs
        return
            content
            .onAppear { [latest] in
                PuppetVerbs.shared.register(token, modal: modal) { latest.verbs() }
            }
            .onDisappear { PuppetVerbs.shared.unregister(token) }
    }
}

import SwiftUI
import UIKit

struct NoteEditorView: View {
    @EnvironmentObject var store: NotesStore
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.localization) var localization

    /// Current note id. Mutable because renaming changes the file path.
    @State var noteId: String
    /// Drives the (inline) nav-bar title; updated on rename.
    @State var titleField: String
    @State var content: String
    /// The content last written to disk. We only persist when `content` differs
    /// from this, so opening + closing a note WITHOUT editing never rewrites the
    /// file (which would bump its modified date to "now").
    @State var savedContent = ""
    /// The one owner of "a note is open; here is every way it ends": the four
    /// asynchronous workflows (save / rename / adopt / move), the ordering each
    /// exit drains them in, and the latches. See `EditorSession` for the drain
    /// table; this view supplies the effects and holds the note state.
    @State var session = EditorSession()
    /// ONE executor for sync/external changes to this open editor. It owns
    /// rename sequencing plus focused/hidden deferral; the view only supplies
    /// state and renders the engine's disposition.
    @State var openNoteReconciler = OpenNoteReconciler()
    @State var openNoteChangeBuffer = OpenNoteChangeBuffer()
    @State var editorFocused = false
    @State var editVersion: UInt64 = 0
    /// Mirrors the session's interaction lock so SwiftUI re-renders on it (the
    /// session itself stays free of UI-framework dependencies).
    @State var interactionLocked = false
    /// CRITICAL: never block the editor's first frame on a disk read (F9 / the
    /// never-gate-render rule). The body starts empty and is read OFF the main
    /// actor in `.task`; until it lands, `loaded` is false, which gates the
    /// live-sync adopt + the onChange save so an empty placeholder is never
    /// written back over the real note (data-loss guard). Mirrors Android's
    /// `loaded` flag in NoteEditorScreen.kt.
    @State var loaded = false
    @State var documentReady = false
    // Rename is presented from the nav-bar menu (the big title header is gone
    // so the editor can be full-screen).
    @State var showRename = false
    @State var renameField = ""
    /// Move sheet (nav-bar menu "Move to Folder…").
    @State var showMove = false
    /// Destructive delete is always confirmed (list.md parity).
    @State var showDeleteConfirm = false
    /// Inline title-validation warning (desktop parity): a forbidden char shows
    /// a transient 2 s message; a dot/too-long/duplicate shows a persistent one
    /// and blocks the rename. Rendered in danger red under the title field.
    @State var titleWarning: LocalizedMessage?
    @State var titleWarningTask: Task<Void, Never>?
    @State var findVisible = false
    @State var findQuery = ""
    @State var findLabel = "0"
    // How much of the editor viewport the find bar covers, and the two global
    // edges it is derived from. The WebView ignores the container's bottom safe
    // area, so the bar (a bottom overlay) is drawn OVER it — the shared find
    // engine has to know that strip's height to reveal a match above it.
    @State var editorBottomGlobalY: CGFloat = 0
    @State var findBarTopGlobalY: CGFloat = 0
    @State var findOverlayInset: CGFloat = 0
    /// The shared-WebView attachment used to authorize view and find operations.
    /// Document text comes from the mailbox. See ``EditorAttachmentSlot``.
    @State var editorAttachmentSlot = EditorAttachmentSlot()
    var editorAttachment: Int? { editorAttachmentSlot.token }

    /// Whether this editor is the visible top of the stack. With wikilink pushes
    /// several editors coexist; only the visible one may drive the single shared
    /// WebView (an off-screen editor's live-sync adopt would clobber the visible
    /// note's text). Tracked via onAppear/onDisappear.
    @State var isVisible = false
    /// `navPath.count` while this editor is the visible top. Fewer entries at
    /// disappear means it was popped; more means something was pushed over it.
    @State private var stackDepth = 0

    /// This editor's entry in the store's unsaved-draft register (F8 jetsam
    /// guard). Claimed on appear, released on disappear; the editor publishes its
    /// DERIVED draft under this token on every state change (see the `.onChange`
    /// below). Per-token so a wikilink push/pop overlap never evicts a sibling
    /// editor's draft (PKT-1 R2). 0 = not yet claimed.
    @State var draftToken: UInt64 = 0

    /// Path of the enclosing NavigationStack. A resolved-wikilink tap PUSHES a
    /// new editor entry (Back returns to the note you came from — a chain of
    /// editors, like a browser history); a delete pops it. The single shared
    /// editor WebView (EditorHost.shared) re-adopts into whichever editor is
    /// visible, so multiple editors can coexist in the stack — see EditorWebView.
    @Binding var navPath: [Route]

    /// Auto-focus the editor (and raise the keyboard) on open — only for a
    /// brand-new note. Opening an existing note leaves the keyboard down until
    /// the user taps.
    let autoFocus: Bool

    /// The id this editor opened on. A brand-new quick-capture note that is
    /// never touched (body still empty, never renamed → id unchanged) is
    /// discarded on back-out so nothing is left behind — desktop parity
    /// (list.md). Renaming or typing anything keeps it.
    private let originalId: String

    init(noteId: String, autoFocus: Bool = false, navPath: Binding<[Route]>) {
        _noteId = State(initialValue: noteId)
        _titleField = State(initialValue: splitId(id: noteId).title)
        _content = State(initialValue: "")
        // Quick capture comes from the completed create-empty-note workflow.
        _loaded = State(initialValue: autoFocus)
        _navPath = navPath
        self.autoFocus = autoFocus
        self.originalId = noteId
    }

    var theme: String {
        colorScheme == .dark ? "dark" : "light"
    }

    var body: some View {
        // Editor with an inline, tappable title on top (Android parity). The
        // inline field owns the title now — no native nav-bar title — so only
        // Back + the ⋯ menu remain in the nav bar. The note's heading/#tags
        // still render inside the editor body below.
        titleAndEditor
            // Docked from UIKit's keyboard frame, not SwiftUI's keyboard safe area:
            // see KeyboardDock for the iOS 26 case that safe area gets wrong.
            .overlay(alignment: .bottom) {
                if findVisible {
                    KeyboardDock {
                        FindInNoteBar(
                            query: $findQuery,
                            label: findLabel,
                            onQueryChange: { EditorHost.shared.setFindQuery($0) },
                            onStep: { EditorHost.shared.stepFind($0) },
                            onClose: { dismissFind() }
                        )
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .onGeometryChange(for: CGFloat.self) { proxy in
                            proxy.frame(in: .global).minY
                        } action: { top in
                            findBarTopGlobalY = top
                            publishFindOverlayInset()
                        }
                    }
                }
            }
            .allowsHitTesting(!interactionLocked)
            .background(Theme.background)
            .navigationBarTitleDisplayMode(.inline)
            // The SYSTEM back button, deliberately: hiding it also disables UIKit's
            // finger-tracked interactive pop. Back and the edge swipe therefore pop
            // before this view hears about it, and `finishLeave` commits after the
            // fact. See docs/learnings/ios-swipe-back-over-webview.md.
            .toolbar {
                noteActionsToolbar
            }
            .alert(
                localization.localizedText("notes.title.renameHeading"), isPresented: $showRename
            ) {
                TextField(localization.localizedText("notes.title.fieldLabel"), text: $renameField)
                Button(localization.localizedText("common.actions.cancel"), role: .cancel) {}
                Button(localization.localizedText("common.actions.rename")) { commitRename() }
            } message: {
                Text(localization.localizedText("notes.title.renamePrompt"))
            }
            .fullScreenCover(isPresented: $showDeleteConfirm) {
                DestructiveConfirmDialog(
                    message: localization.localizedText(
                        "notes.delete.thisNoteRecoverableConfirmation"
                    ),
                    destructiveLabel: localization.localizedText("notes.actions.deleteNote"),
                    onCancel: {
                        presentWithoutAnimation { showDeleteConfirm = false }
                    },
                    onDestructive: { deleteNote() }
                )
                .presentationBackground(.clear)
            }
            .sheet(isPresented: $showMove) {
                // Keep the complete move in this editor's tracked mutation chain.
                MoveToFolderSheet(
                    note: currentItem,
                    onMoveRequested: { folder in
                        moveNote(to: folder)
                    }
                )
                .environmentObject(store)
            }
            .task {
                // Off-main initial load of the note body. Runs once; SwiftUI cancels
                // the task on disappear, and `loaded` guards re-entry on reappear so
                // a reloaded view never discards in-memory edits.
                guard !loaded else { return }
                let disk: String
                do {
                    disk = try await store.read(noteId)
                } catch {
                    // A note that exists but cannot be read (bytes that are not
                    // UTF-8) never opens as a blank page (desktop loader parity):
                    // `loaded` stays false, so nothing can save over it, and the
                    // editor leaves without writing.
                    if !navPath.isEmpty { navPath.removeLast() }
                    return
                }
                EditorHost.shared.prepareLoad(noteId)
                content = disk
                savedContent = disk
                loaded = true
            }
            .onReceive(store.$notes) { _ in
                // Keep the embed's note universe (wikilink resolution/autocomplete)
                // current. Independent of the open note's load state; deduped by
                // EditorHost on the JSON string. The initial subscription publish
                // covers the first push; EditorHost re-pushes on a fresh 'ready'.
                pushNotesUniverse()
            }
            .onReceive(store.$localTreeChange) { summary in
                guard let summary else { return }
                let change = OpenNoteChange(summary: summary)
                if let ready = openNoteChangeBuffer.receive(change, isLoaded: documentReady) {
                    scheduleOpenNoteReconciliation(ready)
                }
            }
            .onAppear {
                isVisible = true
                stackDepth = navPath.count
                // Mirror the session's interaction lock into view state. Assigned
                // here rather than at construction because `@State`'s initializer
                // cannot reach `self`.
                session.onInteractionLockChanged = { interactionLocked = $0 }
                // Claim a register entry once and publish the current derived draft
                // (nil until the body loads / diverges). Re-appearing after a cover
                // re-claims because onDisappear released the previous token.
                if draftToken == 0 { draftToken = store.claimDraftOwnership() }
                publishDraft()
                store.setDraftFlushWaiter(token: draftToken) { await flushEditorMailbox() }
                // Re-gather after a buried editor becomes visible. This settles any
                // hidden or focused deferral against current disk rather than
                // applying a stale content snapshot.
                if documentReady { scheduleOpenNoteReconciliation(.external) }
            }
            // Keep the register's derivation current: any change to loaded/noteId/
            // savedContent/content re-publishes this editor's draft (or clears it the
            // instant content==savedContent — a completed save or adopted remote).
            // This single reactive site replaces the old scattered setPendingDraft
            // set/clear calls (PKT-1 R1-R4, PKT-12 R5).
            .onChange(of: draftInputs) { _, _ in publishDraft() }
            .onDisappear {
                // Presenting the centered delete confirmation covers this view but
                // is not navigation. Preserve its save chain and draft ownership.
                guard !showDeleteConfirm else { return }
                CloseLedger.mark("editorDisappeared", note: noteId)
                closeFind()
                // Covered (a wikilink pushed a new editor) or popped: no longer the
                // visible editor, so it must stop driving the shared WebView.
                isVisible = false
                // Popped by the system Back button or the edge swipe, which never
                // asked `requestNavigation`. A covered editor already ran that exit
                // before the push; a deleted or externally closed one latched closed.
                if navPath.count <= stackDepth, !session.isClosing, !isUntouchedCapture {
                    finishLeave()
                    return
                }
                session.cancel(.save)
                // Drop any pending debounced rename on leave (Android parity — its
                // rename coroutine is canceled the same way).
                session.cancel(.rename)
                // Discard an untouched quick-capture note: backing out leaves
                // nothing behind (list.md).
                var shouldReleaseDraft = true
                if !session.isClosing && isUntouchedCapture {
                    store.deleteAsync(noteId, ownerToken: draftToken)
                } else if session.shouldFlushOnLeave(
                    loaded: loaded,
                    content: content,
                    savedContent: savedContent
                ) {
                    // POP flush (navigating back isn't a background signal, so the
                    // scenePhase handler won't fire). Persist-or-park through the
                    // engine, retaining this exact draft until the async flush is
                    // durable so an I/O failure remains eligible for lifecycle retry.
                    let draft = PendingDraft(id: noteId, base: savedContent, content: content)
                    store.publishDraft(token: draftToken, draft)
                    store.retainDraftUntilFlushed(token: draftToken)
                    store.flushAsync(draft, ownerToken: draftToken)
                    shouldReleaseDraft = false
                }
                // A clean/untouched editor releases its own entry. A dirty editor's
                // entry stays retained until the asynchronous flush is durable, so
                // a failed leave save remains eligible for a later lifecycle retry.
                if shouldReleaseDraft { store.releaseDraftOwnership(token: draftToken) }
                draftToken = 0
            }
    }

    /// A brand-new quick-capture note that was never touched: opened with
    /// autofocus, never renamed (id unchanged AND title still the created
    /// placeholder), body still empty and never persisted.
    private var isUntouchedCapture: Bool {
        autoFocus && noteId == originalId
            && titleField == splitId(id: originalId).title
            && content.isEmpty && savedContent.isEmpty
    }
}

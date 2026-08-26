import SwiftUI
import UIKit

struct RenameResolution {
    let id: String
    let isCommitted: Bool
}

func resolvedRename(
    currentId: String,
    outcome: NoteMutationOutcome<String>
) -> RenameResolution {
    switch outcome {
    case .committed(let finalId):
        RenameResolution(id: finalId, isCommitted: true)
    case .failed:
        RenameResolution(id: currentId, isCommitted: false)
    }
}

/// What the editor tells the user when an exit refuses to leave. Kept together
/// so the three exits stay consistent about "your change is still pending" —
/// the promise the session's drain-and-commit is there to keep.
private func titleValidationMessage(_ kind: String) -> LocalizedMessage? {
    switch kind {
    case "empty":
        return LocalizedMessage("notes.title.empty")
    case "forbidden_chars":
        return LocalizedMessage("notes.title.forbiddenCharacter")
    case "leading_dots":
        return LocalizedMessage("notes.title.leadingDot")
    case "trailing_dots":
        return LocalizedMessage("notes.title.trailingDot")
    case "too_long":
        return LocalizedMessage(
            "notes.title.tooLong",
            arguments: ["maxLength": TitleSpec.maxLength]
        )
    default:
        return nil
    }
}

struct NoteEditorView: View {
    @EnvironmentObject private var store: NotesStore
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.localization) private var localization

    /// Current note id. Mutable because renaming changes the file path.
    @State private var noteId: String
    /// Drives the (inline) nav-bar title; updated on rename.
    @State private var titleField: String
    @State private var content: String
    /// The content last written to disk. We only persist when `content` differs
    /// from this, so opening + closing a note WITHOUT editing never rewrites the
    /// file (which would bump its modified date to "now").
    @State private var savedContent = ""
    /// The one owner of "a note is open; here is every way it ends": the four
    /// asynchronous workflows (save / rename / adopt / move), the ordering each
    /// exit drains them in, and the latches. See `EditorSession` for the drain
    /// table; this view supplies the effects and holds the note state.
    @State private var session = EditorSession()
    /// ONE executor for sync/external changes to this open editor. It owns
    /// rename sequencing plus focused/hidden deferral; the view only supplies
    /// state and renders the engine's disposition.
    @State private var openNoteReconciler = OpenNoteReconciler()
    @State private var openNoteChangeBuffer = OpenNoteChangeBuffer()
    @State private var editorFocused = false
    @State private var editVersion: UInt64 = 0
    /// Mirrors the session's interaction lock so SwiftUI re-renders on it (the
    /// session itself stays free of UI-framework dependencies).
    @State private var interactionLocked = false
    /// CRITICAL: never block the editor's first frame on a disk read (F9 / the
    /// never-gate-render rule). The body starts empty and is read OFF the main
    /// actor in `.task`; until it lands, `loaded` is false, which gates the
    /// live-sync adopt + the onChange save so an empty placeholder is never
    /// written back over the real note (data-loss guard). Mirrors Android's
    /// `loaded` flag in NoteEditorScreen.kt.
    @State private var loaded = false
    // Rename is presented from the nav-bar menu (the big title header is gone
    // so the editor can be full-screen).
    @State private var showRename = false
    @State private var renameField = ""
    /// Move sheet (nav-bar menu "Move to Folder…").
    @State private var showMove = false
    /// Destructive delete is always confirmed (list.md parity).
    @State private var showDeleteConfirm = false
    /// Inline title-validation warning (desktop parity): a forbidden char shows
    /// a transient 2 s message; a dot/too-long/duplicate shows a persistent one
    /// and blocks the rename. Rendered in danger red under the title field.
    @State private var titleWarning: LocalizedMessage?
    @State private var titleWarningTask: Task<Void, Never>?
    @State private var findVisible = false
    @State private var findQuery = ""
    @State private var findLabel = "0"
    // How much of the editor viewport the find bar covers, and the two global
    // edges it is derived from. The WebView ignores the container's bottom safe
    // area, so the bar (a `.safeAreaInset`) is drawn OVER it — the shared find
    // engine has to know that strip's height to reveal a match above it.
    @State private var editorBottomGlobalY: CGFloat = 0
    @State private var findBarTopGlobalY: CGFloat = 0
    @State private var findOverlayInset: CGFloat = 0
    @State private var editorAttachment: Int?

    /// Whether this editor is the visible top of the stack. With wikilink pushes
    /// several editors coexist; only the visible one may drive the single shared
    /// WebView (an off-screen editor's live-sync adopt would clobber the visible
    /// note's text). Tracked via onAppear/onDisappear.
    @State private var isVisible = false

    /// This editor's entry in the store's unsaved-draft register (F8 jetsam
    /// guard). Claimed on appear, released on disappear; the editor publishes its
    /// DERIVED draft under this token on every state change (see the `.onChange`
    /// below). Per-token so a wikilink push/pop overlap never evicts a sibling
    /// editor's draft (PKT-1 R2). 0 = not yet claimed.
    @State private var draftToken: UInt64 = 0

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
        _navPath = navPath
        self.autoFocus = autoFocus
        self.originalId = noteId
    }

    private var theme: String {
        colorScheme == .dark ? "dark" : "light"
    }

    var body: some View {
        // Editor with an inline, tappable title on top (Android parity). The
        // inline field owns the title now — no native nav-bar title — so only
        // Back + the ⋯ menu remain in the nav bar. The note's heading/#tags
        // still render inside the editor body below.
        VStack(spacing: 0) {
            // Backed by UITextField so tapping a still-placeholder title
            // ("Untitled"/"Untitled-N") selects it whole — a keystroke replaces
            // it — while a real title takes the caret at the tapped character.
            // Edits rename the file, debounced (scheduleRename). [list.md]
            TitleTextField(
                text: $titleField,
                placeholder: localization.localizedText("notes.untitledPlaceholder"),
                onChange: { handleTitleChange($0) },
                onForbidden: {
                    setTitleWarning(
                        LocalizedMessage("notes.title.forbiddenCharacter"),
                        transient: true
                    )
                }
            )
            .padding(.horizontal, 20)
            .padding(.top, 4)
            .padding(.bottom, titleWarning == nil ? 6 : 2)
            if let warning = titleWarning {
                Text(localization.localizedText(warning.path, arguments: warning.arguments))
                    .font(.caption)
                    .foregroundStyle(Theme.danger)
                    .padding(.horizontal, 20)
                    .padding(.bottom, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            EditorWebView(
                content: content,
                theme: theme,
                localization: localization,
                autoFocus: autoFocus,
                onChange: { newContent in
                    // Data-loss guard: ignore editor change events until the off-main
                    // initial read has landed (`loaded`). The reused WebView mounts
                    // with the new note's content via setContent and can emit an echo
                    // before the disk read returns; saving that echo could clobber the
                    // note on disk. Once loaded, all edits flow through.
                    switch session.disposition(loaded: loaded) {
                    case .ignore:
                        return
                    case .quarantine:
                        session.quarantine(newContent)
                        return
                    case .apply:
                        break
                    }
                    editVersion &+= 1
                    content = newContent
                    // Publish the derived draft SYNCHRONOUSLY here, not only via the
                    // async `.onChange(of: draftInputs)` below. The scenePhase
                    // background handler reads the register synchronously on
                    // `.inactive`; SwiftUI may not have run the `.onChange` publish
                    // yet in the same update pass, so an edit-then-immediate-
                    // background could leave the register stale and lose the newest
                    // keystroke to jetsam (N1 — this restores the pre-refactor
                    // synchronous publish). publishDraft runs the same derivation, so
                    // a clean buffer still publishes nil (no R1 regression); the
                    // derived `.onChange` still owns clear-on-save/clear-on-adopt.
                    // F8 jetsam guard.
                    publishDraft()
                    scheduleSave(newContent)
                },
                onFocusChange: { focused in
                    editorFocused = focused
                    if openNoteReconciler.shouldReconcileAfterFocusChange(
                        isFocused: focused
                    ) {
                        scheduleOpenNoteReconciliation(.external)
                    }
                },
                onOpenNote: { id in
                    openLinkedNote(id)
                },
                onFindMatches: { report in
                    findQuery = report.query
                    findLabel = report.label
                },
                onAttachmentChange: { editorAttachment = $0
                }
            )
            // Measured INSIDE ignoresSafeArea: that is the WebView's RENDERED
            // bottom (the window's edge, or the keyboard's top when the IME is
            // up). Measured outside, SwiftUI reports the pre-expansion layout
            // frame instead — which shrinks by exactly the bar's height when the
            // bar appears and would report an overlay of zero.
            .onGeometryChange(for: CGFloat.self) { proxy in
                proxy.frame(in: .global).maxY
            } action: { bottom in
                editorBottomGlobalY = bottom
                publishFindOverlayInset()
            }
            .ignoresSafeArea(.container, edges: .bottom)
        }
        // A sibling at the bottom of the VStack can still extend into the
        // keyboard-covered region when the WebView ignores the container's
        // bottom safe area. A safe-area inset participates in SwiftUI's
        // keyboard avoidance and keeps the complete bar above the IME.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if findVisible {
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
        // Swipe-back. Sits INSIDE the allowsHitTesting gate below, so an
        // in-flight mutation disables the swipe exactly as it disables the Back
        // button. Routed through requestNavigation, so the swipe and the button
        // share one exit path. See EditorEdgeSwipeBack.
        .overlay(alignment: .leading) {
            EditorEdgeSwipeBack {
                requestNavigation {
                    if !navPath.isEmpty { navPath.removeLast() }
                }
            }
            .frame(width: EditorEdgeSwipeBack.stripWidth)
            .ignoresSafeArea(.container, edges: .bottom)
        }
        .allowsHitTesting(!interactionLocked)
        .background(Theme.background)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    requestNavigation {
                        if !navPath.isEmpty { navPath.removeLast() }
                    }
                } label: {
                    Image(systemName: "chevron.left")
                }
                .disabled(interactionLocked)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        findVisible = true
                        // Re-measure for this presentation: the bar has not been
                        // laid out yet, so the inset arrives a frame later and
                        // the engine re-reveals the current match against it.
                        findOverlayInset = 0
                        EditorHost.shared.openFind()
                    } label: {
                        Label("Find in note", systemImage: "magnifyingglass")
                    }
                    Button {
                        renameField = splitId(id: noteId).title
                        showRename = true
                    } label: {
                        Label(
                            localization.localizedText("common.actions.rename"),
                            systemImage: "pencil"
                        )
                    }
                    Button {
                        prepareMove()
                    } label: {
                        Label(
                            localization.localizedText("notes.actions.moveToFolderEllipsis"),
                            systemImage: "folder"
                        )
                    }
                    Button {
                        UIPasteboard.general.string = store.notePath(noteId)
                    } label: {
                        Label(
                            localization.localizedText("notes.actions.copyFilePath"),
                            systemImage: "doc.on.doc"
                        )
                    }
                    ShareLink(item: content) {
                        Label(
                            localization.localizedText("notes.actions.share"),
                            systemImage: "square.and.arrow.up"
                        )
                    }
                    Divider()
                    Button(role: .destructive) {
                        presentWithoutAnimation { showDeleteConfirm = true }
                    } label: {
                        Label(
                            localization.localizedText("notes.actions.deleteNote"),
                            systemImage: "trash"
                        )
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("More")
                .tint(Theme.primary)
                .disabled(interactionLocked)
            }
        }
        .alert(localization.localizedText("notes.title.renameHeading"), isPresented: $showRename) {
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
                currentFolder: splitId(id: noteId).folder,
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
            let disk = await store.read(noteId)
            content = disk
            savedContent = disk
            loaded = true
            scheduleOpenNoteReconciliation(openNoteChangeBuffer.finishInitialLoad())
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
            if let ready = openNoteChangeBuffer.receive(change, isLoaded: loaded) {
                scheduleOpenNoteReconciliation(ready)
            }
        }
        .onAppear {
            isVisible = true
            // Mirror the session's interaction lock into view state. Assigned
            // here rather than at construction because `@State`'s initializer
            // cannot reach `self`.
            session.onInteractionLockChanged = { interactionLocked = $0 }
            // Claim a register entry once and publish the current derived draft
            // (nil until the body loads / diverges). Re-appearing after a cover
            // re-claims because onDisappear released the previous token.
            if draftToken == 0 { draftToken = store.claimDraftOwnership() }
            publishDraft()
            // Re-gather after a buried editor becomes visible. This settles any
            // hidden or focused deferral against current disk rather than
            // applying a stale content snapshot.
            if loaded { scheduleOpenNoteReconciliation(.external) }
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
            closeFind()
            // Covered (a wikilink pushed a new editor) or popped: no longer the
            // visible editor, so it must stop driving the shared WebView.
            isVisible = false
            session.cancel(.save)
            // Drop any pending debounced rename on leave (Android parity — its
            // rename coroutine is cancelled the same way).
            session.cancel(.rename)
            // Discard an untouched quick-capture note: opened brand-new
            // (autoFocus), never renamed (id unchanged AND title still the
            // created placeholder), body still empty and never persisted.
            // Backing out leaves nothing behind (list.md).
            let untouched =
                autoFocus && noteId == originalId
                && titleField == splitId(id: originalId).title
                && content.isEmpty && savedContent.isEmpty
            var shouldReleaseDraft = true
            if !session.isClosing && untouched {
                store.deleteAsync(noteId)
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
                store.flushAsync(draft)
                shouldReleaseDraft = false
            }
            // A clean/untouched editor releases its own entry. A dirty editor's
            // entry stays retained until the asynchronous flush is durable, so
            // a failed leave save remains eligible for a later lifecycle retry.
            if shouldReleaseDraft { store.releaseDraftOwnership(token: draftToken) }
            draftToken = 0
        }
    }

    /// Publish the strip of the editor viewport the find bar covers: everything
    /// from the bar's top edge down to the WebView's bottom edge (the bar sits
    /// above the home-indicator inset the WebView also extends into). Only while
    /// the bar is up, and only when the measurement actually moved — the engine
    /// latches the value, so this is one call per presentation or resize.
    private func publishFindOverlayInset() {
        guard findVisible else { return }
        let inset = max(0, editorBottomGlobalY - findBarTopGlobalY)
        guard abs(inset - findOverlayInset) >= 0.5 else { return }
        findOverlayInset = inset
        EditorHost.shared.setFindOverlayInset(inset)
    }

    private func closeFind() {
        findVisible = false
        if let editorAttachment,
            EditorHost.shared.isCurrentAttachment(editorAttachment)
        {
            EditorHost.shared.closeFind()
        }
    }

    /// The close control belongs to the visible editor, so it must always close
    /// that editor's find engine. Lifecycle cleanup above stays token-gated: an
    /// off-screen view disappearing after a linked note adopted the shared
    /// WebView must not close find in the newer owner.
    private func dismissFind() {
        findVisible = false
        EditorHost.shared.closeFind()
    }

    /// The inputs the draft derivation depends on, bundled so a single
    /// `.onChange` re-publishes whenever any of them moves.
    private var draftInputs: DraftInputs {
        DraftInputs(loaded: loaded, noteId: noteId, savedContent: savedContent, content: content)
    }

    /// Publish this editor's DERIVED draft into the store's register under its
    /// token (no-op before the token is claimed). The derivation returns nil the
    /// instant the body is clean (content == savedContent), so a completed save or
    /// an adopted remote clears the draft with no explicit clear call.
    private func publishDraft() {
        guard draftToken != 0 else { return }
        store.publishDraft(
            token: draftToken,
            derivePendingDraft(
                loaded: loaded, noteId: noteId, savedContent: savedContent, content: content))
    }

    private func scheduleSave(_ newContent: String) {
        session.schedule(.save) {
            try? await Task.sleep(nanoseconds: 400_000_000)  // 0.4s debounce
            guard session.isActive else { return false }
            // Re-read identity and base at FIRE time. A sync disposition may
            // have followed a rename or rebased the draft while this debounce
            // waited; the engine's flush verb, never a raw write, resolves that
            // three-way state without clobbering the peer version.
            let savedId = noteId
            let base = savedContent
            let disposition = await store.flushDraft(
                PendingDraft(id: savedId, base: base, content: newContent))
            // No cancellation guard here, deliberately: by the time the flush
            // answers, its write is durable, and this task is routinely cancelled
            // by the next keystroke's `session.schedule(.save)`. Skipping the
            // baseline advance on that cancellation left `savedContent` behind
            // disk, so the next flush's `base` no longer matched — and the engine
            // parked this editor's own earlier write as a conflict copy.
            // `settledFlush` owns that decision and vetoes on identity only.
            switch settledFlush(
                disposition: disposition,
                writtenContent: newContent,
                flushedId: savedId,
                currentId: noteId,
                sessionIsClosing: session.isClosing
            ) {
            case .ignore:
                return false
            case .record(let content):
                savedContent = content
            case .follow(let parkedId, let content):
                savedContent = content
                noteId = parkedId
                titleField = splitId(id: parkedId).title
                store.showTransient(LocalizedMessage("notes.save.conflictCopy"))
            }
            return true
        }
    }

    private func commitRename() {
        let requestedTitle = renameField
        session.schedule(.rename) {
            await applyRename(requestedTitle)
        }
    }

    /// Debounced inline-title rename (Android parity): reschedule on each
    /// keystroke and rename once typing settles. Cancelled on leave/delete.
    private func scheduleRename(_ newTitle: String) {
        session.schedule(.rename) {
            try? await Task.sleep(nanoseconds: 500_000_000)  // 0.5s debounce
            guard session.isActive else { return false }
            return await applyRename(newTitle)
        }
    }

    /// Rename the current note from a raw title. Sanitizes; no-ops on an empty
    /// or unchanged title. Shared by the inline title field and the ⋯ Rename
    /// alert.
    ///
    /// GHOST-NOTE FIX (F7): cancel the in-flight debounced save AND flush any
    /// pending body edit to the CURRENT id before the file moves. Without this,
    /// a stale save (which captured the OLD id) would run after the rename and
    /// recreate a ghost note at the old path (write_note creates files
    /// unconditionally) — data loss. Mirrors Android's NoteEditorScreen.kt.
    private func applyRename(_ rawTitle: String) async -> Bool {
        guard !session.isClosing else { return false }
        let parts = splitId(id: noteId)
        let trimmed = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        // Reject empty (sanitizeTitle would coerce to "Untitled" and lose the
        // note's identity).
        guard !trimmed.isEmpty else { return true }
        // Block the rename while the title is illegal (dot/too-long — forbidden
        // chars are already stripped in the field) or would collide with an
        // existing note. The inline warning stays up; desktop parity.
        guard validateTitle(title: trimmed).allSatisfy({ $0.kind == "empty" }) else { return true }
        guard !isDuplicateTitle(trimmed) else { return true }
        let sanitized = sanitizeTitle(title: trimmed)
        guard sanitized != parts.title else { return true }

        session.cancel(.save)
        // Snapshot the body BEFORE the suspending write and advance savedContent
        // to exactly that snapshot — never to the live `content`. If the user
        // types during the suspended write, `content` moves ahead of the bytes on
        // disk; assigning savedContent from live `content` would mark that newer
        // keystroke as saved and the derived register would go clean, losing it on
        // background/process death (PKT-12 F1). The register re-keys to the new id
        // after the rename (its content follows the live noteId), so no manual
        // clear is needed.
        let flushed = content
        if flushed != savedContent {
            let outcome = await store.write(noteId, content: flushed)
            savedContent = confirmedSavedContent(
                previousSavedContent: savedContent,
                writtenContent: flushed,
                outcome: outcome
            )
            guard case .committed = outcome else { return false }
        }

        let targetId = makeId(folder: parts.folder, title: sanitized)
        let resolution = resolvedRename(
            currentId: noteId,
            outcome: await store.rename(oldId: noteId, newId: targetId)
        )
        guard resolution.isCommitted else {
            store.showTransient(LocalizedMessage("notes.title.renameFailed"))
            return false
        }
        noteId = resolution.id
        titleField = splitId(id: resolution.id).title
        return true
    }

    /// Inline title editing (desktop parity): update the persistent warning for
    /// the current text and (re)schedule the debounced rename. The forbidden-char
    /// transient warning is raised separately by the field's `onForbidden`.
    private func handleTitleChange(_ cleaned: String) {
        // Persistent, rename-blocking issues: leading/trailing dot, too long, or
        // a duplicate. (`empty` is silent; `forbidden_chars` can't occur — the
        // field strips them.)
        let blocking = validateTitle(title: cleaned)
            .first(where: { $0.kind != "empty" && $0.kind != "forbidden_chars" })
        if let issue = blocking, let message = titleValidationMessage(issue.kind) {
            setTitleWarning(message, transient: false)
        } else if isDuplicateTitle(cleaned) {
            setTitleWarning(LocalizedMessage("notes.title.duplicate"), transient: false)
        } else {
            clearTitleWarning()
        }
        scheduleRename(cleaned)
    }

    /// Would renaming to `raw` collide with a different existing note in the same
    /// folder? Mirrors desktop's `hasDuplicateTitle`.
    private func isDuplicateTitle(_ raw: String) -> Bool {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let parts = splitId(id: noteId)
        let targetId = makeId(folder: parts.folder, title: sanitizeTitle(title: trimmed))
        return targetId != noteId && store.notes.contains { $0.id == targetId }
    }

    /// Show the inline title warning. `transient` messages (forbidden char)
    /// auto-hide after 2 s; persistent ones (dot/too-long/duplicate) stay until
    /// the title becomes legal.
    private func setTitleWarning(_ message: LocalizedMessage, transient: Bool) {
        titleWarningTask?.cancel()
        titleWarning = message
        guard transient else { return }
        titleWarningTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if !Task.isCancelled { titleWarning = nil }
        }
    }

    private func clearTitleWarning() {
        titleWarningTask?.cancel()
        titleWarning = nil
    }

    /// The open note's list item — for the move sheet. Falls back to a synthetic
    /// item when the store is mid-reload (the sheet only needs id/title/folder).
    private var currentItem: NoteItem {
        if let item = store.notes.first(where: { $0.id == noteId }) { return item }
        let parts = splitId(id: noteId)
        return NoteItem(
            id: noteId, title: parts.title, folder: parts.folder,
            modified: Date(), preview: "", richPreview: "", tags: [])
    }

    /// Supply the reconciler with live editor state and the synchronous effects
    /// that render Rust's exhaustive disposition. No conflict policy lives in
    /// this view.
    private func openNoteEffects() -> OpenNoteReconcileEffects {
        OpenNoteReconcileEffects(
            snapshot: {
                guard loaded, !session.isClosing else { return nil }
                return OpenNoteEditorSnapshot(
                    id: noteId,
                    base: savedContent,
                    draft: content,
                    isFocused: editorFocused,
                    isVisible: isVisible,
                    editVersion: editVersion
                )
            },
            cancelAndDrainSave: {
                await session.cancelAndDrain(.save)
            },
            readDisk: { id in
                try await store.readIfExists(id)
            },
            resumeDraftSave: {
                if content != savedContent { scheduleSave(content) }
            },
            followRename: { toId in
                noteId = toId
                titleField = splitId(id: toId).title
            },
            adopt: { disk in
                EditorHost.shared.applyExternal(content: disk)
                content = disk
                savedContent = disk
            },
            keepDraft: { base, reason in
                savedContent = base
                switch reason {
                case .peerDeleted:
                    store.showTransient(LocalizedMessage("notes.save.openNoteDeletedKeepingDraft"))
                case .diverged:
                    store.showTransient(LocalizedMessage("notes.save.localEditsKept"))
                case .converged:
                    break
                }
                if content != savedContent { scheduleSave(content) }
            },
            close: {
                session.closeForExternalDelete()
                savedContent = content
                store.showTransient(LocalizedMessage("notes.deletedElsewhere"))
                if !navPath.isEmpty { navPath.removeLast() }
            }
        )
    }

    /// Push the note universe ([{id,title,modifiedMs,tags}] JSON) into the
    /// embed for suffix resolution, autocomplete, and wikilink decoration. The
    /// built JSON doubles as the dedupe signature — EditorHost skips the
    /// evaluateJavaScript when it matches the last push.
    private func pushNotesUniverse() {
        let items: [[String: Any]] = store.notes.map { note in
            [
                "id": note.id,
                "title": note.title,
                "modifiedMs": Int64(note.modified.timeIntervalSince1970 * 1000),
                "tags": note.tags,
            ]
        }
        let data =
            (try? JSONSerialization.data(withJSONObject: items, options: [.sortedKeys]))
            ?? Data("[]".utf8)
        EditorHost.shared.setNotes(String(data: data, encoding: .utf8) ?? "[]")
    }

    /// Bridge 'openNote': the user tapped a RESOLVED wikilink. PUSH a new editor
    /// entry so Back returns to the note you came FROM (not straight to the
    /// list). This view's onDisappear flushes any pending draft to the old id
    /// before the pushed editor's first save can fire. The editor WebView is a
    /// single shared instance (EditorHost.shared); EditorWebView re-adopts it
    /// into whichever editor is visible, so the stacked editors stay correct on
    /// Back. Skip a self-link (a wikilink to the note you're already on).
    private func openLinkedNote(_ id: String) {
        guard id != noteId else { return }
        requestNavigation {
            navPath.append(.note(id))
        }
    }

    /// Back and resolved-wikilink navigation are mutations of the editor
    /// session: wait for every already-admitted identity workflow, then commit
    /// the latest body snapshot. A failed commit leaves this editor visible and
    /// dirty so navigation can be retried without losing the draft.
    private func requestNavigation(_ navigate: @escaping () -> Void) {
        session.end(
            .navigate,
            effects: EditorExitEffects(
                captureBody: { await EditorHost.shared.captureCurrentContent() },
                commitBody: { flushed in
                    content = flushed
                    // Only a loaded, dirty editor has anything to persist.
                    guard loaded, flushed != savedContent else { return true }
                    let disposition = await store.flushDraft(
                        PendingDraft(id: noteId, base: savedContent, content: flushed))
                    // Any durable persist-or-park outcome lets navigation finish.
                    guard disposition != nil else { return false }
                    savedContent = flushed
                    return true
                },
                commitTitle: { await applyRename(titleField) },
                perform: { _ in
                    navigate()
                    return true
                },
                onFailed: { failure, _, _ in
                    switch failure {
                    case .title:
                        store.showTransient(LocalizedMessage("notes.navigation.renamePending"))
                    case .capture:
                        store.showTransient(LocalizedMessage("notes.navigation.captureFailed"))
                    case .body:
                        store.showTransient(LocalizedMessage("notes.navigation.saveFailed"))
                    case .action:
                        break
                    }
                }
            )
        )
    }

    /// Nav-bar "Move to Folder…": wait for already-admitted identity work before
    /// presenting destinations. The final live body is captured and committed
    /// only after the user chooses a destination in [moveNote].
    private func prepareMove() {
        session.end(
            .prepareMove,
            effects: EditorExitEffects(
                perform: { _ in
                    showMove = true
                    return true
                }
            )
        )
    }

    /// The move sheet hands the destination back synchronously so this editor
    /// owns the complete capture, persist-or-park, and move transaction. Delete
    /// can then cancel/await that exact task and, if the move already committed,
    /// target its final id.
    private func moveNote(to folder: String) {
        session.end(
            .move,
            effects: EditorExitEffects(
                captureBody: { await EditorHost.shared.captureCurrentContent() },
                commitBody: { flushed in
                    content = flushed
                    guard flushed != savedContent else { return true }
                    guard
                        let disposition = await store.flushDraft(
                            PendingDraft(id: noteId, base: savedContent, content: flushed))
                    else { return false }
                    savedContent = flushed
                    // A parked draft moved the live note to the conflict copy,
                    // so that is what the move must carry.
                    let sourceId = editorMoveSourceId(
                        currentId: noteId, disposition: disposition)
                    if sourceId != noteId {
                        noteId = sourceId
                        titleField = splitId(id: sourceId).title
                    }
                    return true
                },
                perform: { _ in
                    switch await store.moveNote(noteId, toFolder: folder) {
                    case .committed(let finalId):
                        // Apply even if a delete latched the session closed while
                        // the actor call was in flight. Delete awaits this task
                        // and must see the committed id.
                        noteId = finalId
                        titleField = splitId(id: finalId).title
                        return true
                    case .failed:
                        return false
                    }
                },
                onFailed: { failure, _, _ in
                    switch failure {
                    case .capture:
                        store.showTransient(LocalizedMessage("notes.move.captureFailed"))
                    case .body:
                        store.showTransient(LocalizedMessage("notes.move.saveFailed"))
                    case .action:
                        if !session.isClosing {
                            store.showTransient(LocalizedMessage("notes.errors.moveFailed"))
                        }
                    case .title:
                        break
                    }
                }
            )
        )
    }

    /// Confirmed delete from the nav-bar menu: neutralize every pending-save
    /// path FIRST (a write after the delete would resurrect the file — the Rust
    /// write creates files unconditionally), then delete and pop the editor.
    private func deleteNote() {
        session.end(
            .delete,
            effects: EditorExitEffects(
                // The session has already cancelled every workflow and latched
                // closed, so a bridge change arriving from here on is
                // quarantined rather than applied.
                prepare: { EditorHost.shared.blur() },
                captureBody: { await EditorHost.shared.captureCurrentContent() },
                commitBody: { body in
                    let hasPendingChanges = body != savedContent
                    let writeOutcome =
                        hasPendingChanges
                        ? await store.write(noteId, content: body)
                        : nil
                    if let writeOutcome {
                        savedContent = confirmedSavedContent(
                            previousSavedContent: savedContent,
                            writtenContent: body,
                            outcome: writeOutcome
                        )
                    }
                    return shouldContinueDeleteAfterEditorWrite(
                        hasPendingChanges: hasPendingChanges,
                        outcome: writeOutcome
                    )
                },
                perform: { committedBody in
                    content = committedBody ?? content
                    savedContent = content
                    // Clear the draft register only after every dirty snapshot
                    // commits. A retained draft cannot then recreate the note.
                    publishDraft()
                    let outcome = await store.delete(noteId)
                    if case .committed = outcome { return true }
                    return false
                },
                onSucceeded: {
                    EditorHost.shared.invalidateAsyncCompletions()
                    presentWithoutAnimation { showDeleteConfirm = false }
                    if !navPath.isEmpty { navPath.removeLast() }
                },
                onFailed: { failure, lateContent, attemptedBody in
                    switch failure {
                    case .capture:
                        content = lateContent ?? content
                        presentWithoutAnimation { showDeleteConfirm = false }
                        publishDraft()
                        if content != savedContent { scheduleSave(content) }
                        store.showTransient(LocalizedMessage("notes.delete.captureFailed"))
                    case .body:
                        content = lateContent ?? attemptedBody ?? content
                        presentWithoutAnimation { showDeleteConfirm = false }
                        publishDraft()
                        scheduleSave(content)
                        store.showTransient(LocalizedMessage("notes.delete.savePending"))
                    case .action:
                        if let lateContent {
                            content = lateContent
                            scheduleSave(lateContent)
                        }
                        presentWithoutAnimation { showDeleteConfirm = false }
                        publishDraft()
                        store.showTransient(LocalizedMessage("notes.errors.deleteFailed"))
                    case .title:
                        break
                    }
                }
            )
        )
    }

    /// Coalesce external-change signals into the editor session's adoption
    /// workflow. A stale pass retries with fresh facts; every individual pass
    /// still performs exactly one post-read identity/visibility validation.
    private func scheduleOpenNoteReconciliation(_ change: OpenNoteChange) {
        guard !session.isClosing else { return }
        let effects = openNoteEffects()
        session.schedule(.adopt) {
            for _ in 0..<3 {
                let result = await openNoteReconciler.reconcile(
                    change: change,
                    effects: effects
                )
                if result != .stale { break }
            }
            return true
        }
    }
}

private struct FindInNoteBar: View {
    @Binding var query: String
    let label: String
    let onQueryChange: (String) -> Void
    let onStep: (Int) -> Void
    let onClose: () -> Void

    @FocusState private var fieldFocused: Bool

    var body: some View {
        HStack(spacing: 8) {
            Button(action: onClose) {
                Image(systemName: "checkmark")
                    .font(.system(size: 18, weight: .semibold))
                    .frame(width: 46, height: 46)
                    .foregroundStyle(.white)
                    .background(Theme.primary, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close find")

            HStack(spacing: 7) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(.secondary)

                // A find query is matched literally against note text, so the
                // keyboard must not shape it: autocapitalization turned typed
                // "example" into "Example" on device, and autocorrect can
                // silently rewrite a query into one that matches nothing.
                TextField("Find", text: $query)
                    .textFieldStyle(.plain)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($fieldFocused)
                    .submitLabel(.search)
                    .onSubmit { onStep(1) }
                    .onChange(of: query) { _, value in onQueryChange(value) }
                    .onKeyPress(.return, phases: .down) { press in
                        guard press.modifiers.contains(.shift) else { return .ignored }
                        onStep(-1)
                        return .handled
                    }
                    .accessibilityLabel("Find in note")

                Text(label)
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .fixedSize()

                if !query.isEmpty {
                    Button { query = "" } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear find query")
                }
            }
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: 46)
            .background(Theme.surface, in: Capsule())

            HStack(spacing: 0) {
                Button { onStep(-1) } label: {
                    Image(systemName: "chevron.up")
                        .frame(width: 42, height: 46)
                }
                .accessibilityLabel("Previous match")

                Button { onStep(1) } label: {
                    Image(systemName: "chevron.down")
                        .frame(width: 42, height: 46)
                }
                .accessibilityLabel("Next match")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .background(Theme.surface, in: Capsule())
        }
        .task { fieldFocused = true }
    }
}

func editorMoveSourceId(currentId: String, disposition: FlushDisposition) -> String {
    switch disposition {
    case .parkedConflict(let parkedId):
        return parkedId
    case .wrote, .converged, .recreated:
        return currentId
    }
}

/// The state the unsaved-draft derivation reads, bundled into one Equatable
/// value so a single `.onChange` fires on any relevant change.
private struct DraftInputs: Equatable {
    let loaded: Bool
    let noteId: String
    let savedContent: String
    let content: String
}

/// A note title that is still the auto-assigned placeholder: exactly "Untitled",
/// or a dedup variant "Untitled-N" (see the Rust store's `unique_note_id`, which
/// appends `-2`, `-3`, …). Tapping such a title selects it whole so a keystroke
/// replaces it; any other title takes the caret at the tapped character.
func isPlaceholderTitle(_ t: String) -> Bool {
    if t == "Untitled" { return true }
    guard t.hasPrefix("Untitled-") else { return false }
    let suffix = t.dropFirst("Untitled-".count)
    return !suffix.isEmpty && suffix.allSatisfy(\.isNumber)
}

/// Inline, tappable note title — the iOS counterpart of Android's title
/// `BasicTextField`. Backed by `UITextField` so the tap behaviour is exact:
/// beginning to edit a placeholder title selects the whole text (a keystroke
/// replaces it), while a real title keeps UIKit's tap-positioned caret. Text
/// edits are reported via `onChange` (the editor debounces the rename).
// Not `private`: TitleTextFieldLayoutTests hosts it to measure its width, and
// `@testable import` cannot reach a private type.
struct TitleTextField: UIViewRepresentable {
    @Binding var text: String
    let placeholder: String
    var onChange: (String) -> Void
    /// A forbidden character was typed and stripped (drives the transient warning).
    var onForbidden: () -> Void = {}

    func makeUIView(context: Context) -> UITextField {
        let tf = UITextField()
        tf.delegate = context.coordinator
        tf.text = text
        tf.placeholder = placeholder
        tf.font = .systemFont(ofSize: 22, weight: .semibold)
        tf.textColor = .label
        tf.returnKeyType = .done
        tf.clearButtonMode = .never
        // Titles are proper nouns as often as sentences; don't fight the user.
        tf.autocapitalizationType = .sentences
        tf.addTarget(
            context.coordinator, action: #selector(Coordinator.editingChanged(_:)),
            for: .editingChanged)
        tf.setContentHuggingPriority(.required, for: .vertical)
        tf.setContentCompressionResistancePriority(.required, for: .vertical)
        return tf
    }

    func updateUIView(_ uiView: UITextField, context: Context) {
        context.coordinator.parent = self
        uiView.placeholder = placeholder
        // Adopt external title changes (a debounced/remote rename rewrote it)
        // WITHOUT stomping what the user is actively typing.
        if !uiView.isFirstResponder, uiView.text != text {
            uiView.text = text
        }
    }

    /// Take the offered width verbatim instead of the width the text wants
    /// (list.md). A definite proposal is a real layout slot, so the field fills
    /// it and no more. A nil/infinite proposal is SwiftUI asking for an ideal
    /// size, where the natural text width is the honest answer — returning nil
    /// defers to it.
    func sizeThatFits(
        _ proposal: ProposedViewSize, uiView: UITextField, context: Context
    ) -> CGSize? {
        guard let width = proposal.width, width.isFinite else { return nil }
        let height = uiView.systemLayoutSizeFitting(
            CGSize(width: width, height: UIView.layoutFittingCompressedSize.height),
            withHorizontalFittingPriority: .required,
            verticalFittingPriority: .fittingSizeLevel
        ).height
        return CGSize(width: width, height: height)
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: TitleTextField
        init(_ parent: TitleTextField) { self.parent = parent }

        @objc func editingChanged(_ tf: UITextField) {
            let raw = (tf.text ?? "").replacingOccurrences(of: "\n", with: "")
            // Strip forbidden filesystem chars in-place (desktop parity — the
            // illegal char never persists) and cap at the title length limit.
            var cleaned = String(
                raw.unicodeScalars.filter { !TitleSpec.forbiddenScalars.contains($0) })
            let forbidden = cleaned != raw
            if cleaned.count > TitleSpec.maxLength {
                cleaned = String(cleaned.prefix(TitleSpec.maxLength))
            }
            if tf.text != cleaned {
                // Keep the caret roughly where it was: a stripped forbidden char
                // shifts it back one; a length cap clamps it to the end.
                var prev = cleaned.count
                if let start = tf.selectedTextRange?.start {
                    prev = tf.offset(from: tf.beginningOfDocument, to: start)
                }
                let target = max(0, min(cleaned.count, prev - (forbidden ? 1 : 0)))
                tf.text = cleaned
                if let pos = tf.position(from: tf.beginningOfDocument, offset: target) {
                    tf.selectedTextRange = tf.textRange(from: pos, to: pos)
                }
            }
            parent.text = cleaned
            parent.onChange(cleaned)
            if forbidden { parent.onForbidden() }
        }

        func textFieldDidBeginEditing(_ tf: UITextField) {
            // Placeholder title → select all so a keystroke replaces it. Real
            // title → leave UIKit's tap-positioned caret alone. Async so it runs
            // AFTER UIKit places the caret from the tap (otherwise the tap wins).
            guard isPlaceholderTitle(tf.text ?? "") else { return }
            DispatchQueue.main.async { tf.selectAll(nil) }
        }

        func textFieldShouldReturn(_ tf: UITextField) -> Bool {
            tf.resignFirstResponder()
            return false
        }
    }
}

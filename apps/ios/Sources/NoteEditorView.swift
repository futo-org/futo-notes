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

func editorDeleteContent(
    capturedContent: String?,
    quarantinedContent: String?
) -> String? {
    guard let capturedContent else { return nil }
    return quarantinedContent ?? capturedContent
}

struct NoteEditorView: View {
    @EnvironmentObject private var store: NotesStore
    @Environment(\.colorScheme) private var colorScheme

    /// Current note id. Mutable because renaming changes the file path.
    @State private var noteId: String
    /// Drives the (inline) nav-bar title; updated on rename.
    @State private var titleField: String
    @State private var content: String
    /// The content last written to disk. We only persist when `content` differs
    /// from this, so opening + closing a note WITHOUT editing never rewrites the
    /// file (which would bump its modified date to "now").
    @State private var savedContent = ""
    @State private var saveTask: Task<Void, Never>?
    /// Debounced inline-title rename (Android parity) — rescheduled per keystroke.
    @State private var renameTask: Task<Bool, Never>?
    /// Consecutive adoption requests form one cancellation-aware chain. Waiting
    /// for the latest task therefore waits for every older in-flight flush too.
    @State private var adoptionTask: Task<Void, Never>?
    @State private var moveTask: Task<Void, Never>?
    @State private var navigationTask: Task<Void, Never>?
    @State private var isMoveCommitting = false
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
    @State private var titleWarning: String?
    @State private var titleWarningTask: Task<Void, Never>?

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

    /// Set when THIS editor tears itself down (menu Delete): the local delete's
    /// store reload re-fires `.onReceive($notes)` → `adoptExternalChange`, which
    /// would otherwise mistake the user's own delete for a peer delete (wrong
    /// "deleted during sync" banner + a double pop in a wikilink chain). A
    /// one-way latch for this view instance.
    @State private var isClosing = false
    /// A bridge change that arrives after delete starts is quarantined. A
    /// committed delete discards it; a failed delete restores it so no late
    /// animation-frame edit is silently lost.
    @State private var closingContent: String?

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
                onChange: { handleTitleChange($0) },
                onForbidden: {
                    setTitleWarning(
                        "That character can't be used in a note title", transient: true)
                }
            )
            .padding(.horizontal, 20)
            .padding(.top, 4)
            .padding(.bottom, titleWarning == nil ? 6 : 2)
            if let warning = titleWarning {
                Text(warning)
                    .font(.caption)
                    .foregroundStyle(Theme.danger)
                    .padding(.horizontal, 20)
                    .padding(.bottom, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            EditorWebView(
                content: content,
                theme: theme,
                autoFocus: autoFocus,
                onChange: { newContent in
                    // Data-loss guard: ignore editor change events until the off-main
                    // initial read has landed (`loaded`). The reused WebView mounts
                    // with the new note's content via setContent and can emit an echo
                    // before the disk read returns; saving that echo could clobber the
                    // note on disk. Once loaded, all edits flow through.
                    switch editorChangeDisposition(loaded: loaded, isClosing: isClosing) {
                    case .ignore:
                        return
                    case .quarantine:
                        closingContent = newContent
                        return
                    case .apply:
                        break
                    }
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
                onOpenNote: { id in
                    openLinkedNote(id)
                }
            )
            .ignoresSafeArea(.container, edges: .bottom)
        }
        .allowsHitTesting(navigationTask == nil && !isMoveCommitting)
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
                .disabled(navigationTask != nil || isMoveCommitting)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        renameField = splitId(id: noteId).title
                        showRename = true
                    } label: {
                        Label("Rename", systemImage: "pencil")
                    }
                    Button {
                        prepareMove()
                    } label: {
                        Label("Move to Folder…", systemImage: "folder")
                    }
                    Button {
                        UIPasteboard.general.string = store.notePath(noteId)
                    } label: {
                        Label("Copy File Path", systemImage: "doc.on.doc")
                    }
                    ShareLink(item: content) {
                        Label("Share", systemImage: "square.and.arrow.up")
                    }
                    Divider()
                    Button(role: .destructive) {
                        presentWithoutAnimation { showDeleteConfirm = true }
                    } label: {
                        Label("Delete Note", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .tint(Theme.primary)
                .disabled(navigationTask != nil || isMoveCommitting)
            }
        }
        .alert("Rename note", isPresented: $showRename) {
            TextField("Title", text: $renameField)
            Button("Cancel", role: .cancel) {}
            Button("Rename") { commitRename() }
        } message: {
            Text("Enter a new name for this note.")
        }
        .fullScreenCover(isPresented: $showDeleteConfirm) {
            DestructiveConfirmDialog(
                message: "Delete this note? This action cannot be undone.",
                destructiveLabel: "Delete Note",
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
        }
        .onReceive(store.$notes) { _ in
            // Keep the embed's note universe (wikilink resolution/autocomplete)
            // current. Independent of the open note's load state; deduped by
            // EditorHost on the JSON string. The initial subscription publish
            // covers the first push; EditorHost re-pushes on a fresh 'ready'.
            pushNotesUniverse()
            // Live-sync refresh for the OPEN note. A live pull rewrites the file
            // and reloads the store; without this, the open editor keeps showing
            // (and on exit, SAVES BACK) a stale base — silently clobbering the
            // remote edit. See adoptExternalChange for the clean/dirty rules.
            guard loaded else { return }
            scheduleExternalAdoption()
        }
        .onAppear {
            isVisible = true
            // Claim a register entry once and publish the current derived draft
            // (nil until the body loads / diverges). Re-appearing after a cover
            // re-claims because onDisappear released the previous token.
            if draftToken == 0 { draftToken = store.claimDraftOwnership() }
            publishDraft()
            // Re-check the note on RE-appearance (returning from a wikilink cover).
            // A peer may have deleted or changed it while this editor was buried;
            // `.onReceive($notes)` does NOT re-fire for it on a plain Back (no store
            // change), so without this a buried peer-deleted note stays bound to a
            // dead id and the next keystroke's UNCONDITIONAL debounced save
            // resurrects it fleet-wide (H2). adoptExternalChange applies the same
            // close/keep/adopt decision as a live pull. Gated on `loaded` so it
            // never runs before the initial read (a fresh open is already current).
            if loaded { scheduleExternalAdoption() }
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
            guard shouldHandleEditorDisappear(
                isDeleteConfirmationPresented: showDeleteConfirm
            ) else { return }
            // Covered (a wikilink pushed a new editor) or popped: no longer the
            // visible editor, so it must stop driving the shared WebView.
            isVisible = false
            saveTask?.cancel()
            // Drop any pending debounced rename on leave (Android parity — its
            // rename coroutine is cancelled the same way).
            renameTask?.cancel()
            // Discard an untouched quick-capture note: opened brand-new
            // (autoFocus), never renamed (id unchanged AND title still the
            // created placeholder), body still empty and never persisted.
            // Backing out leaves nothing behind (list.md).
            let untouched =
                autoFocus && noteId == originalId
                && titleField == splitId(id: originalId).title
                && content.isEmpty && savedContent.isEmpty
            var shouldReleaseDraft = true
            if !isClosing && untouched {
                store.deleteAsync(noteId)
            } else if shouldFlushEditorOnDisappear(
                loaded: loaded,
                isClosing: isClosing,
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
        let previous = saveTask
        previous?.cancel()
        saveTask = Task { @MainActor in
            await previous?.value
            try? await Task.sleep(nanoseconds: 400_000_000) // 0.4s debounce
            if Task.isCancelled || isClosing { return }
            // Re-read `noteId` at FIRE time (not schedule time) so a save that
            // lands after a rename writes to the renamed note, not the stale id.
            // This is the second half of the ghost-note fix (F7); the first half
            // is the flush+cancel in commitRename. Mirrors Android's
            // NoteEditorScreen.kt re-read at the debounce fire.
            let outcome = await store.write(noteId, content: newContent)
            savedContent = confirmedSavedContent(
                previousSavedContent: savedContent,
                writtenContent: newContent,
                outcome: outcome
            )
        }
    }

    private func commitRename() {
        let requestedTitle = renameField
        let previous = renameTask
        previous?.cancel()
        renameTask = Task { @MainActor in
            await previous?.value
            guard !Task.isCancelled, !isClosing else { return false }
            return await applyRename(requestedTitle)
        }
    }

    /// Debounced inline-title rename (Android parity): reschedule on each
    /// keystroke and rename once typing settles. Cancelled on leave/delete.
    private func scheduleRename(_ newTitle: String) {
        let previous = renameTask
        previous?.cancel()
        renameTask = Task { @MainActor in
            await previous?.value
            try? await Task.sleep(nanoseconds: 500_000_000)  // 0.5s debounce
            if Task.isCancelled || isClosing { return false }
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
        guard !isClosing else { return false }
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

        saveTask?.cancel()
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
            store.showTransient("Couldn't rename note. Your title is still pending.")
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
        if let issue = blocking {
            setTitleWarning(issue.message, transient: false)
        } else if isDuplicateTitle(cleaned) {
            setTitleWarning("A note with this name already exists", transient: false)
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
    private func setTitleWarning(_ message: String, transient: Bool) {
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

    /// Adopt an on-disk change of the OPEN note (live pull / external rewrite).
    /// Clean draft → adopt through the selection-preserving applyExternalContent
    /// path (sync.md: a remote update must not reset the caret). Dirty draft →
    /// the draft is parked as a "<title> (conflict YYYY-MM-DD)" copy and the
    /// disk content adopted, so neither side is silently lost.
    private func adoptExternalChange() async {
        guard !isClosing else { return }
        // Snapshot the id: a debounced rename/move can change `noteId` DURING the
        // awaits below. Acting on the stale id would (a) treat a rename's
        // "old id no longer exists" as a peer delete and pop the renamed editor
        // with a spurious banner, or (b) park/adopt against the wrong note (N3).
        // After every suspension, bail if the editor has since re-keyed.
        let id = noteId
        guard await store.exists(id) else {
            // A rename moved the old id away (exists false) — that is NOT a peer
            // delete. Only treat it as one if we're still on the same note.
            if noteId == id { handleOpenNoteDeleted() }
            return
        }
        guard noteId == id else { return }
        let disk = await store.read(id)
        guard noteId == id else { return }
        // Branch on the CURRENT draft state — the user may have typed while the
        // read was in flight (we're back on the main actor here).
        if content == savedContent {
            // Clean draft: adopt silently, caret/scroll preserved.
            guard disk != savedContent else { return }
            // Only push into the shared WebView when visible; a stacked-but-
            // hidden editor updates its in-memory state and re-pushes on Back.
            if isVisible { EditorHost.shared.applyExternal(content: disk) }
            content = disk
            savedContent = disk
        } else if disk == savedContent {
            // Disk unchanged (reload was about some other note) — draft wins.
        } else if disk == content {
            // Draft and remote converged on the same text — nothing to park.
            // savedContent = disk makes the derivation null this note's draft.
            savedContent = disk
        } else {
            // True three-way conflict: cancel the pending save (it would clobber
            // the remote edit — store.write is unconditional), then route the
            // draft through the engine's ONE flush verb, so the live-pull path
            // and the leave/background flush share the park semantics and the
            // conflict-copy naming by construction.
            saveTask?.cancel()
            // Snapshot the draft BEFORE the suspending flush: a keystroke landing
            // during the await (main-actor reentrancy — the PKT-12 F1 hazard
            // applyRename/scheduleSave avoid) must stay dirty, not be marked
            // saved and lost on pop/jetsam. The engine persists exactly this
            // snapshot; assigning `flushed` (not the live `content`) leaves any
            // newer keystroke dirty for the next flush.
            let flushed = content
            guard !isClosing else { return }
            let disposition = await store.flushDraft(
                PendingDraft(id: id, base: savedContent, content: flushed))
            guard !isClosing else { return }
            guard noteId == id else { return }
            switch adoptFlushOutcome(for: disposition) {
            case .keepDraft:
                // wrote / recreated / converged: the flushed draft is on disk at
                // the original id (converged = an in-flight autosave landed it
                // first). Keep the draft in the editor — do NOT adopt the stale
                // pre-flush `disk` snapshot, which is gone from disk; adopting it
                // clean would let the next keystroke's unconditional autosave
                // destroy the just-persisted draft with no copy (F3).
                savedContent = flushed
            case .reloadDisk:
                // Parked as a conflict copy. The engine decided that outcome
                // from a serialized re-check, so the pre-flush `disk` snapshot
                // is no longer authoritative. Re-read before adopting.
                guard content == flushed else {
                    // A newer keystroke landed during the flush. Re-evaluate it
                    // against current disk instead of replacing it or letting
                    // its unconditional autosave clobber the peer version.
                    await adoptExternalChange()
                    return
                }
                let refreshedDisk = await store.read(id)
                guard noteId == id else { return }
                guard content == flushed else {
                    await adoptExternalChange()
                    return
                }
                if isVisible { EditorHost.shared.applyExternal(content: refreshedDisk) }
                content = refreshedDisk
                savedContent = refreshedDisk
            case .retryLater:
                // Flush failed (I/O): leave the draft dirty so the next signal
                // (autosave, background flush, re-adopt) retries.
                return
            }
        }
    }

    /// A peer deleted the currently-open note (a live pull removed the file and
    /// the store reloaded). Matches desktop F4 semantics (sync.md):
    ///   * clean draft → close the editor and tell the user ("Note was deleted
    ///     during sync"); nothing is written, so the delete stands fleet-wide;
    ///   * dirty draft → keep the editor open (edit-wins re-create-with-edits):
    ///     the pending body edit is preserved and the debounced save re-creates
    ///     the note, with a "keeping local draft" banner.
    /// Only the VISIBLE editor acts — a buried editor in a wikilink stack must not
    /// pop the top of the stack. A buried editor re-evaluates via the `.onAppear`
    /// re-adopt when the user navigates back to it (H2), so a peer-deleted buried
    /// note is closed/kept on return rather than staying bound to a dead id where
    /// the next keystroke's unconditional autosave would resurrect it. The
    /// background/leave flush honors the same edit-wins promise through the
    /// engine's flush verb (a dirty draft of a deleted note is Recreated at the
    /// original id; a clean editor never flushes).
    private func handleOpenNoteDeleted() {
        guard isVisible, !isClosing else { return }
        if content == savedContent {
            // Clean: neutralize any pending write so nothing resurrects the note,
            // mark the draft clean (register + onDisappear flush become no-ops),
            // then close and inform. `isClosing` guards a concurrent adopt (the
            // onAppear re-check and an `.onReceive` fire can both land) from popping
            // the stack twice.
            saveTask?.cancel()
            renameTask?.cancel()
            isClosing = true
            savedContent = content
            store.showTransient("Note was deleted during sync")
            if !navPath.isEmpty { navPath.removeLast() }
        } else {
            // Dirty: keep the draft — the debounced save re-creates the note with
            // the local edits (edit-wins). Inform once per delete event.
            store.showTransient("Open note was deleted during sync; keeping local draft")
        }
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
        let data = (try? JSONSerialization.data(withJSONObject: items, options: [.sortedKeys]))
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
        guard navigationTask == nil, !isClosing else { return }
        let pendingRename = renameTask
        let pendingAdoption = adoptionTask
        let pendingMove = moveTask
        navigationTask = Task { @MainActor in
            await pendingAdoption?.value
            await pendingMove?.value
            guard !Task.isCancelled, !isClosing else {
                navigationTask = nil
                return
            }

            var renameCommitted = await pendingRename?.value ?? true
            if !renameCommitted {
                renameCommitted = await applyRename(titleField)
            }
            guard renameCommitted else {
                navigationTask = nil
                store.showTransient(
                    "Couldn't rename note. Navigation is paused while your title remains pending."
                )
                return
            }

            let pendingSave = saveTask
            pendingSave?.cancel()
            await pendingSave?.value

            guard let flushed = await EditorHost.shared.captureCurrentContent() else {
                navigationTask = nil
                store.showTransient(
                    "Couldn't read the latest note. Navigation is paused while your changes remain pending."
                )
                return
            }
            content = flushed
            if needsEditorCommitBeforeNavigation(
                loaded: loaded,
                content: flushed,
                savedContent: savedContent
            ) {
                let disposition = await store.flushDraft(
                    PendingDraft(id: noteId, base: savedContent, content: flushed))
                guard shouldCompleteEditorNavigation(disposition) else {
                    navigationTask = nil
                    store.showTransient(
                        "Couldn't save note. Navigation is paused while your changes remain pending."
                    )
                    return
                }
                savedContent = flushed
            }

            navigationTask = nil
            navigate()
        }
    }

    /// Nav-bar "Move to Folder…": wait for already-admitted identity work before
    /// presenting destinations. The final live body is captured and committed
    /// only after the user chooses a destination in [moveNote].
    private func prepareMove() {
        let previous = moveTask
        let pendingRename = renameTask
        let pendingAdoption = adoptionTask
        previous?.cancel()
        moveTask = Task { @MainActor in
            await previous?.value
            await pendingRename?.value
            await pendingAdoption?.value
            guard !Task.isCancelled, !isClosing else { return }
            showMove = true
        }
    }

    /// The move sheet hands the destination back synchronously so this editor
    /// owns the complete capture, persist-or-park, and move transaction. Delete
    /// can then cancel/await that exact task and, if the move already committed,
    /// target its final id.
    private func moveNote(to folder: String) {
        let previous = moveTask
        let pendingRename = renameTask
        let pendingAdoption = adoptionTask
        isMoveCommitting = true
        moveTask = Task { @MainActor in
            defer {
                if !isClosing { isMoveCommitting = false }
            }
            await previous?.value
            await pendingRename?.value
            await pendingAdoption?.value
            guard !Task.isCancelled, !isClosing else { return }

            let pendingSave = saveTask
            pendingSave?.cancel()
            await pendingSave?.value

            guard let flushed = await EditorHost.shared.captureCurrentContent() else {
                store.showTransient(
                    "Couldn't read the latest note. Move is paused while your changes remain pending."
                )
                return
            }
            content = flushed

            var sourceId = noteId
            if flushed != savedContent {
                let disposition = await store.flushDraft(
                    PendingDraft(id: sourceId, base: savedContent, content: flushed))
                guard let disposition else {
                    store.showTransient(
                        "Couldn't save note. Move is paused while your changes remain pending."
                    )
                    return
                }
                savedContent = flushed
                sourceId = editorMoveSourceId(currentId: sourceId, disposition: disposition)
                if sourceId != noteId {
                    noteId = sourceId
                    titleField = splitId(id: sourceId).title
                }
            }

            let outcome = await store.moveNote(sourceId, toFolder: folder)
            switch outcome {
            case .committed(let finalId):
                // Apply even if delete set `isClosing` while the actor call was in
                // flight. Delete awaits this task and must see the committed id.
                noteId = finalId
                titleField = splitId(id: finalId).title
            case .failed:
                if !isClosing {
                    store.showTransient("Couldn't move note. It remains in its current folder.")
                }
            }
        }
    }

    /// Confirmed delete from the nav-bar menu: neutralize every pending-save
    /// path FIRST (a write after the delete would resurrect the file — the Rust
    /// write creates files unconditionally), then delete and pop the editor.
    private func deleteNote() {
        let pendingSave = saveTask
        let pendingRename = renameTask
        let pendingAdoption = adoptionTask
        let pendingMove = moveTask
        saveTask?.cancel()
        renameTask?.cancel()
        adoptionTask?.cancel()
        moveTask?.cancel()
        // Latch closing so the local delete's reload doesn't trip the peer-delete
        // path (adoptExternalChange → handleOpenNoteDeleted).
        isClosing = true
        closingContent = nil
        EditorHost.shared.blur()
        Task { @MainActor in
            await pendingSave?.value
            await pendingRename?.value
            await pendingAdoption?.value
            await pendingMove?.value

            let capturedContent = await EditorHost.shared.captureCurrentContent()
            guard let capturedDeleteContent = editorDeleteContent(
                capturedContent: capturedContent,
                quarantinedContent: closingContent
            ) else {
                content = closingContent ?? content
                closingContent = nil
                isClosing = false
                presentWithoutAnimation { showDeleteConfirm = false }
                publishDraft()
                if content != savedContent { scheduleSave(content) }
                store.showTransient(
                    "Couldn't read the latest note. Delete is paused while your changes remain pending."
                )
                return
            }

            var finalContent = capturedDeleteContent
            closingContent = nil
            while true {
                let hasPendingChanges = finalContent != savedContent
                let writeOutcome = hasPendingChanges
                    ? await store.write(noteId, content: finalContent)
                    : nil
                if let writeOutcome {
                    savedContent = confirmedSavedContent(
                        previousSavedContent: savedContent,
                        writtenContent: finalContent,
                        outcome: writeOutcome
                    )
                }
                guard shouldContinueDeleteAfterEditorWrite(
                    hasPendingChanges: hasPendingChanges,
                    outcome: writeOutcome
                ) else {
                    content = closingContent ?? finalContent
                    closingContent = nil
                    isClosing = false
                    presentWithoutAnimation { showDeleteConfirm = false }
                    publishDraft()
                    scheduleSave(content)
                    store.showTransient(
                        "Couldn't save note. Delete is paused while your changes remain pending."
                    )
                    return
                }
                guard let laterContent = closingContent else { break }
                closingContent = nil
                finalContent = laterContent
            }

            content = finalContent
            savedContent = finalContent
            // Clear the draft register only after every dirty snapshot commits.
            // A retained draft cannot then recreate the note after Delete.
            publishDraft()
            let outcome = await store.delete(noteId)
            if case .committed = outcome {
                closingContent = nil
                EditorHost.shared.invalidateAsyncCompletions()
                presentWithoutAnimation { showDeleteConfirm = false }
                if !navPath.isEmpty { navPath.removeLast() }
            } else {
                let lateContent = closingContent
                closingContent = nil
                isClosing = false
                if let lateContent {
                    content = lateContent
                    scheduleSave(lateContent)
                }
                presentWithoutAnimation { showDeleteConfirm = false }
                publishDraft()
                store.showTransient("Couldn't delete note. It remains in your notes.")
            }
        }
    }

    /// Coalesce live-reload signals without abandoning an older in-flight
    /// engine flush. The latest task represents the whole predecessor chain,
    /// which lets local delete await every adoption before deleting last.
    private func scheduleExternalAdoption() {
        guard !isClosing else { return }
        let previous = adoptionTask
        previous?.cancel()
        adoptionTask = Task { @MainActor in
            await previous?.value
            guard !Task.isCancelled, !isClosing else { return }
            await adoptExternalChange()
        }
    }
}

enum EditorChangeDisposition: Equatable {
    case ignore
    case quarantine
    case apply
}

func editorChangeDisposition(loaded: Bool, isClosing: Bool) -> EditorChangeDisposition {
    if !loaded { return .ignore }
    return isClosing ? .quarantine : .apply
}

func shouldFlushEditorOnDisappear(
    loaded: Bool,
    isClosing: Bool,
    content: String,
    savedContent: String
) -> Bool {
    loaded && !isClosing && content != savedContent
}

func shouldHandleEditorDisappear(isDeleteConfirmationPresented: Bool) -> Bool {
    !isDeleteConfirmationPresented
}

func needsEditorCommitBeforeNavigation(
    loaded: Bool,
    content: String,
    savedContent: String
) -> Bool {
    loaded && content != savedContent
}

func shouldCompleteEditorNavigation(_ disposition: FlushDisposition?) -> Bool {
    disposition != nil
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
private struct TitleTextField: UIViewRepresentable {
    @Binding var text: String
    var onChange: (String) -> Void
    /// A forbidden character was typed and stripped (drives the transient warning).
    var onForbidden: () -> Void = {}

    func makeUIView(context: Context) -> UITextField {
        let tf = UITextField()
        tf.delegate = context.coordinator
        tf.text = text
        tf.placeholder = "Untitled"
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
        // Adopt external title changes (a debounced/remote rename rewrote it)
        // WITHOUT stomping what the user is actively typing.
        if !uiView.isFirstResponder, uiView.text != text {
            uiView.text = text
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: TitleTextField
        init(_ parent: TitleTextField) { self.parent = parent }

        @objc func editingChanged(_ tf: UITextField) {
            let raw = (tf.text ?? "").replacingOccurrences(of: "\n", with: "")
            // Strip forbidden filesystem chars in-place (desktop parity — the
            // illegal char never persists) and cap at the title length limit.
            var cleaned = String(raw.unicodeScalars.filter { !TitleSpec.forbiddenScalars.contains($0) })
            let forbidden = cleaned != raw
            if cleaned.count > TitleSpec.maxLength { cleaned = String(cleaned.prefix(TitleSpec.maxLength)) }
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

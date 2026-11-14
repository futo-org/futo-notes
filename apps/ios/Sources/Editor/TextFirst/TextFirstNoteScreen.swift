import SwiftUI
import UIKit

/// The shipping note screen: a native title field above the text-first
/// editor. Saving is the engine's (the Store's debounce, a checkpoint when the app leaves the
/// foreground, a detach when this screen leaves), so the screen never holds the note body;
/// a rename goes through the Store's ordinary workflow, which retargets the live attachment.
struct TextFirstNoteScreen: View {
    @EnvironmentObject var store: NotesStore
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.localization) private var localization

    @State private var noteId: String
    @State var titleField: String
    @State var titleDuplicate = false
    @State var controller: TextFirstEditorController?
    @State var ownerToken: UInt64 = 0
    @State var renameTask: Task<Void, Never>?
    @State var leaving = false
    /// Bumped whenever this screen leaves, so an open that was still waiting for a claim can
    /// tell the screen it started on is gone.
    @State private var openTicket = 0
    @State private var confirmDiscard = false
    @State private var showRename = false
    @State private var renameField = ""
    @State private var showMove = false
    @State private var showDeleteConfirm = false
    @State private var actionBusy = false
    @State private var actionTask: Task<Void, Never>?
    @Binding var navPath: [Route]

    let autoFocus: Bool
    private let originalId: String

    init(noteId: String, autoFocus: Bool, navPath: Binding<[Route]>) {
        _noteId = State(initialValue: noteId)
        _titleField = State(initialValue: splitId(id: noteId).title)
        _navPath = navPath
        self.autoFocus = autoFocus
        originalId = noteId
    }

    var body: some View {
        VStack(spacing: 0) {
            TitleTextField(
                text: $titleField,
                placeholder: localization.localizedText("notes.untitledPlaceholder"),
                onChange: { titleChanged($0) },
                onForbidden: {
                    store.showTransient(LocalizedMessage("notes.title.forbiddenCharacter"))
                },
                onSubmit: { _ = controller?.textView.becomeFirstResponder() }
            )
            .padding(.horizontal, 20)
            .padding(.top, 4)
            .padding(.bottom, 6)
            if titleDuplicate {
                Text(localization.localizedText("notes.title.duplicate"))
                    .font(.caption)
                    .foregroundStyle(Theme.danger)
                    .padding(.horizontal, 20)
                    .padding(.bottom, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let controller {
                TextFirstSaveBanner(
                    model: controller.saveModel, localization: localization,
                    retry: { controller.checkpoint() },
                    discard: { confirmDiscard = true })
            }
            Group {
                if let controller {
                    // The editor alone runs under the home indicator (the text view's own
                    // safe-area inset keeps the last line reachable); the find bar below
                    // stays inside the safe area, so it sits above the indicator.
                    TextFirstEditorRepresentable(
                        controller: controller, theme: colorScheme == .dark ? "dark" : "light"
                    )
                    .ignoresSafeArea(.container, edges: .bottom)
                    TextFirstCompletionList(
                        model: controller.completionModel, localization: localization,
                        accept: { controller.acceptCompletion(noteId: $0) },
                        dismiss: { controller.dismissCompletion() })
                } else {
                    Color.clear
                }
            }
            // A layout sibling above the keyboard, so the note never runs under the bar.
            if let controller {
                TextFirstFindBar(model: controller.findModel, controller: controller)
            }
        }
        .background(Theme.background)
        .allowsHitTesting(!actionBusy)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NoteActionsMenu(
                    noteId: noteId,
                    content: { await controller?.readContent() },
                    find: { controller?.openFind() },
                    rename: {
                        renameField = splitId(id: noteId).title
                        showRename = true
                    },
                    move: { showMove = true },
                    delete: { presentWithoutAnimation { showDeleteConfirm = true } }
                )
                .disabled(
                    controller == nil || controller?.opening == true
                        || controller?.engineBusy == true || actionBusy)
            }
        }
        .alert(localization.localizedText("notes.title.renameHeading"), isPresented: $showRename) {
            TextField(localization.localizedText("notes.title.fieldLabel"), text: $renameField)
            Button(localization.localizedText("common.actions.cancel"), role: .cancel) {}
            Button(localization.localizedText("common.actions.rename")) {
                titleField = renameField
                titleDuplicate = false
                renameTask?.cancel()
                let requested = renameField
                renameTask = Task { await renameTo(requested) }
            }
        } message: {
            Text(localization.localizedText("notes.title.renamePrompt"))
        }
        .sheet(isPresented: $showMove) {
            MoveToFolderSheet(
                note: currentItem,
                onMoveRequested: { folder in
                    let task = performNoteAction { controller in
                        let id = await controller.refreshIdentity()
                        switch await store.moveNote(id, toFolder: folder, ownerToken: ownerToken) {
                        case .committed(let committed):
                            controller.adoptIdentity(committed.id)
                            controller.drainCoordinatedChanges()
                            return true
                        case .failed:
                            store.showTransient(LocalizedMessage("notes.errors.moveFailed"))
                            return false
                        }
                    }
                    return task
                }
            )
            .environmentObject(store)
        }
        .fullScreenCover(isPresented: $showDeleteConfirm) {
            DestructiveConfirmDialog(
                message: localization.localizedText("notes.delete.thisNoteRecoverableConfirmation"),
                destructiveLabelKey: "notes.actions.deleteNote",
                onCancel: { presentWithoutAnimation { showDeleteConfirm = false } },
                onDestructive: {
                    defer { presentWithoutAnimation { showDeleteConfirm = false } }
                    let deleted = await performNoteAction { controller in
                        await withCheckedContinuation { done in
                            controller.checkpoint { done.resume() }
                        }
                        guard !controller.saveModel.failed else {
                            store.showTransient(LocalizedMessage("notes.delete.savePending"))
                            return false
                        }
                        let id = await controller.refreshIdentity()
                        guard case .committed = await store.delete(id, ownerToken: ownerToken)
                        else {
                            store.showTransient(LocalizedMessage("notes.errors.deleteFailed"))
                            return false
                        }
                        controller.discard()
                        if !navPath.isEmpty { navPath.removeLast() }
                        return true
                    }?.value
                    if deleted == nil {
                        store.showTransient(LocalizedMessage("notes.delete.savePending"))
                    }
                }
            )
            .presentationBackground(.clear)
        }
        #if DEBUG
            .puppetVerbs { nativePuppetVerbs }
        #endif
        .onAppear {
            // Back from a pushed note: the leave closed this editor, so attach it again.
            if leaving, controller == nil {
                leaving = false
                ownerToken = store.claimDraftOwnership()
                Task { await open() }
            }
            #if FUTO_DEBUG_BUILD
                PuppetVerbs.shared.openNote = noteId
            #endif
            if ownerToken == 0 { ownerToken = store.claimDraftOwnership() }
        }
        #if FUTO_DEBUG_BUILD
            .onChange(of: noteId) { _, id in PuppetVerbs.shared.openNote = id }
        #endif
        .task { await open() }
        .onReceive(
            NotificationCenter.default.publisher(
                for: UIApplication.willResignActiveNotification)
        ) {
            _ in checkpointInBackground()
        }
        .onReceive(store.$localTreeChange) { summary in
            guard let summary, let controller, !leaving else { return }
            let change = OpenNoteChange(summary: summary)
            // The engine has already moved the attachment for a rename pair; the checkpoint
            // reports where it is (also when its save fails), so the screen follows.
            if change.affects(noteId) || change.renamed.values.contains(noteId) {
                controller.checkpoint()
            }
        }
        .onReceive(store.$notes) { _ in controller?.refreshNoteIds() }
        .alert(
            localization.localizedText("notes.save.discardQuestion"),
            isPresented: $confirmDiscard
        ) {
            Button(localization.localizedText("notes.save.discard"), role: .destructive) {
                discardDraft()
            }
            Button(localization.localizedText("common.actions.cancel"), role: .cancel) {}
        } message: {
            Text(localization.localizedText("notes.save.discardWarning"))
        }
        .onDisappear {
            // A full-screen camera covers this view without navigating away. Retiring the
            // session there invalidates its image claim and races the re-open on dismissal.
            if navPath.last != .note(originalId) && navPath.last != .newNote(originalId) {
                leave()
            }
        }
    }

    // MARK: open and leave

    /// A long note shows its first screens at once, read-only, while the engine's open runs
    /// beside them (TextFirstEditorController+Opening.swift); a short one opens whole.
    private func open() async {
        guard controller == nil else { return }
        let ticket = openTicket
        // A leave of this note that could not save still owns its draft: take it back (a leave
        // that is still saving is awaited, and its release is what lets a fresh open attach).
        // If this screen is popped again while the claim waits, it declines the draft and the
        // leave goes on owning it.
        let retained = await TextFirstLeaves.claim(noteId) { made in
            guard ticket == openTicket else { return false }
            show(made)
            return true
        }
        if let retained {
            retained.refreshNoteIds()
            return
        }
        guard ticket == openTicket else { return }
        let id = noteId
        do {
            // The session opens on the read its first screens showed (so they are taken
            // first), and input made on them applies to the text it was made on, whatever
            // another writer does meanwhile. With no first screens it opens on the file as it
            // then is.
            let read = await store.readForEditor(id)
            let quick = await store.quickOpenView(read)
            guard ticket == openTicket else { return }
            let opener = Task { try await Self.openSession(store: store, read: read) }
            let made: TextFirstEditorController
            if let quick {
                made = try TextFirstEditorController(noteId: id, quick: quick)
                made.opener = opener
                show(made)
                do {
                    try made.attach(session: try await opener.value)
                } catch {
                    made.abandonOpening()
                    controller = nil
                    throw error
                }
            } else {
                let session = try await opener.value
                guard ticket == openTicket else { return Self.abandon(opener) }
                made = try TextFirstEditorController(noteId: id, session: session)
                show(made)
            }
            made.refreshNoteIds()
            #if FUTO_DEBUG_BUILD
                if let path = ProcessInfo.processInfo.environment["FUTO_TF_STEADY_LOG"] {
                    made.steadyTyper = TextFirstSteadyTyper(controller: made, path: path)
                    made.steadyTyper?.start()
                }
            #endif
        } catch {
            // A note that cannot be opened never shows as a blank page.
            print("text-first: open \(noteId) failed: \(error)")
            // Only while this screen is the one that asked: once it left, the top of the
            // stack is another note's.
            guard ticket == openTicket else { return }
            if !navPath.isEmpty { navPath.removeLast() }
        }
    }

    /// The screen left while its open was in flight: release the session nobody will mount.
    private static func abandon(_ opener: Task<NativeEditorSession, Error>) {
        Task { _ = try? (await opener.value).detach() }
    }

    /// Mount a controller (fresh, or the draft a failed leave kept) on this screen.
    private func show(_ made: TextFirstEditorController) {
        made.onCheckpoint = { result in
            if let mutation = result.mutation { store.applyEditorMutation(mutation) }
            if case .parkedConflict = result.disposition {
                store.showTransient(LocalizedMessage("notes.save.conflictCopy"))
            }
        }
        made.onFailure = { _ in
            store.showTransient(LocalizedMessage("notes.save.failedPending"))
        }
        made.onIdentityChange = { id in adopt(id) }
        made.installToolbar(localization: localization)
        made.onOpenNote = { id in
            if id != noteId { navPath.append(.note(id)) }
        }
        adopt(made.noteId)
        controller = made
        #if DEBUG
            PuppetNativeEditor.shared.attach(made, title: { titleField })
        #endif
        if autoFocus { made.textView.becomeFirstResponder() }
    }

    /// The engine's open; waits while the previous screen's attachment on the note is released.
    private static func openSession(store: NotesStore, read: EditorNoteRead) async throws
        -> NativeEditorSession
    {
        var attempts = 0
        while true {
            do {
                return try await store.openEditorSession(read)
            } catch EditorSessionError.SessionAlreadyOpen where attempts < 20 {
                attempts += 1
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
        }
    }

    /// The attachment moved (a peer's rename, a parked conflict): the screen is now that note.
    private func adopt(_ id: String) {
        guard id != noteId else { return }
        titleField = TextFirstTitle.fieldText(titleField, from: noteId, to: id)
        noteId = id
    }

    private func leave() {
        guard !leaving else { return }
        leaving = true
        openTicket += 1
        renameTask?.cancel()
        #if FUTO_DEBUG_BUILD
            if PuppetVerbs.shared.openNote == noteId { PuppetVerbs.shared.openNote = nil }
        #endif
        guard let controller else {
            store.releaseDraftOwnership(token: ownerToken)
            return
        }
        self.controller = nil
        #if DEBUG
            PuppetNativeEditor.shared.clear(controller)
        #endif
        let untouched =
            autoFocus && titleField == splitId(id: originalId).title && !controller.dirty
        let token = ownerToken
        // A title typed within the rename's debounce commits with the leave.
        let pending = titleField != splitId(id: controller.noteId).title ? titleField : nil
        let action = actionTask
        let rename = renameTask
        let pendingWork = Task<Void, Never> {
            await action?.value
            await rename?.value
        }
        TextFirstLeaves.leave(
            controller: controller, store: store, ownerToken: token,
            discardIfEmpty: untouched, originalId: originalId, pendingTitle: pending,
            renaming: pendingWork)
    }

    /// The user confirmed losing the unsaved edits: end the attachment and go back.
    private func discardDraft() {
        guard let controller else { return }
        leaving = true
        openTicket += 1
        renameTask?.cancel()
        self.controller = nil
        #if DEBUG
            PuppetNativeEditor.shared.clear(controller)
        #endif
        controller.discard()
        store.releaseDraftOwnership(token: ownerToken)
        if !navPath.isEmpty { navPath.removeLast() }
    }

    private func checkpointInBackground() {
        guard let controller, !leaving else { return }
        let background = BackgroundTaskProvider.system
        let handle = background.begin("text-first-checkpoint") {}
        controller.checkpoint { background.end(handle) }
    }

    // MARK: title

    private var currentItem: NoteItem {
        if let item = store.notes.first(where: { $0.id == noteId }) { return item }
        let parts = splitId(id: noteId)
        return NoteItem(
            id: noteId, title: parts.title, folder: parts.folder,
            modified: Date(), richPreview: "", tags: [])
    }

    /// Drain the admitted title work and settle input before using the existing store action.
    /// The store retargets or terminates the attachment atomically with its file mutation.
    private func performNoteAction(
        _ action: @escaping (TextFirstEditorController) async -> Bool
    ) -> Task<Bool, Never>? {
        guard let controller, !controller.opening, !controller.engineBusy, !actionBusy, !leaving
        else {
            return nil
        }
        actionBusy = true
        controller.textView.resignFirstResponder()
        controller.finishComposition()
        let pendingRename = renameTask
        let task = Task { @MainActor in
            await pendingRename?.value
            defer { actionBusy = false }
            return await action(controller)
        }
        actionTask = Task { _ = await task.value }
        return task
    }
}

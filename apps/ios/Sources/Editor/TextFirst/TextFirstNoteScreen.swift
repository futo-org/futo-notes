#if FUTO_DEBUG_BUILD
    import SwiftUI
    import UIKit

    /// The note screen when `TextFirstFlag` is on: a native title field above the text-first
    /// editor. Saving is the engine's (the Store's debounce, a checkpoint when the app leaves the
    /// foreground, a detach when this screen leaves), so the screen never holds the note body;
    /// a rename goes through the Store's ordinary workflow, which retargets the live attachment.
    struct TextFirstNoteScreen: View {
        @EnvironmentObject var store: NotesStore
        @Environment(\.colorScheme) private var colorScheme
        @Environment(\.localization) private var localization

        @State private var noteId: String
        @State private var titleField: String
        @State private var controller: TextFirstEditorController?
        @State private var ownerToken: UInt64 = 0
        @State private var renameTask: Task<Void, Never>?
        @State private var leaving = false
        /// Bumped whenever this screen leaves, so an open that was still waiting for a claim can
        /// tell the screen it started on is gone.
        @State private var openTicket = 0
        @State private var confirmDiscard = false
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
                    }
                )
                .padding(.horizontal, 20)
                .padding(.top, 4)
                .padding(.bottom, 6)
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
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button {
                            controller?.openFind()
                        } label: {
                            Label(
                                localization.localizedText("editor.find.open"),
                                systemImage: "magnifyingglass")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .accessibilityLabel(
                        localization.localizedText("notes.actions.moreAccessibilityLabel")
                    )
                    .tint(Theme.primary)
                    .disabled(controller == nil)
                }
            }
            .onAppear {
                // Back from a pushed note: the leave closed this editor, so attach it again.
                if leaving, controller == nil {
                    leaving = false
                    ownerToken = store.claimDraftOwnership()
                    Task { await open() }
                }
                PuppetVerbs.shared.openNote = noteId
                if ownerToken == 0 { ownerToken = store.claimDraftOwnership() }
            }
            .onChange(of: noteId) { _, id in PuppetVerbs.shared.openNote = id }
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
                if let path = ProcessInfo.processInfo.environment["FUTO_TF_STEADY_LOG"] {
                    made.steadyTyper = TextFirstSteadyTyper(controller: made, path: path)
                    made.steadyTyper?.start()
                }
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
            if PuppetVerbs.shared.openNote == noteId { PuppetVerbs.shared.openNote = nil }
            guard let controller else {
                store.releaseDraftOwnership(token: ownerToken)
                return
            }
            self.controller = nil
            let untouched =
                autoFocus && titleField == splitId(id: originalId).title && !controller.dirty
            let token = ownerToken
            // A title typed within the rename's debounce commits with the leave.
            let pending = titleField != splitId(id: controller.noteId).title ? titleField : nil
            TextFirstLeaves.leave(
                controller: controller, store: store, ownerToken: token,
                discardIfEmpty: untouched, originalId: originalId, pendingTitle: pending,
                renaming: renameTask)
        }

        /// The user confirmed losing the unsaved edits: end the attachment and go back.
        private func discardDraft() {
            guard let controller else { return }
            leaving = true
            openTicket += 1
            renameTask?.cancel()
            self.controller = nil
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

        private func titleChanged(_ cleaned: String) {
            renameTask?.cancel()
            renameTask = Task {
                try? await Task.sleep(nanoseconds: 500_000_000)
                guard !Task.isCancelled, !leaving else { return }
                await renameTo(cleaned)
            }
        }

        /// Rename the attached note to the typed title (see `TextFirstTitle`).
        private func renameTo(_ raw: String) async {
            guard let controller else { return }
            switch await TextFirstTitle.rename(
                to: raw, controller: controller, store: store, ownerToken: ownerToken)
            {
            case .unchanged:
                break
            case .renamed(let id):
                if titleField == raw { titleField = splitId(id: id).title }
            case .failed:
                store.showTransient(LocalizedMessage("notes.title.renameFailed"))
            }
        }
    }
#endif

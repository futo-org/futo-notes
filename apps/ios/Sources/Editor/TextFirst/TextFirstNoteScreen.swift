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
                Group {
                    if let controller {
                        TextFirstEditorRepresentable(
                            controller: controller, theme: colorScheme == .dark ? "dark" : "light")
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
                if change.updatedIds.contains(noteId) || change.deletedIds.contains(noteId)
                    || change.renamed[noteId] != nil
                {
                    controller.checkpoint()
                }
            }
            .onReceive(store.$notes) { _ in controller?.refreshNoteIds() }
            .onDisappear { leave() }
        }

        // MARK: open and leave

        private func open() async {
            guard controller == nil else { return }
            await TextFirstLeaves.awaitLeave(of: noteId)
            var attempts = 0
            while true {
                do {
                    let session = try await store.openEditorSession(noteId)
                    let made = try TextFirstEditorController(noteId: noteId, session: session)
                    made.onCheckpoint = { result in
                        if let mutation = result.mutation { store.applyEditorMutation(mutation) }
                        if case .parkedConflict = result.disposition {
                            store.showTransient(LocalizedMessage("notes.save.conflictCopy"))
                        }
                    }
                    made.onFailure = { _ in
                        store.showTransient(LocalizedMessage("notes.save.failedPending"))
                    }
                    made.installToolbar(localization: localization)
                    made.onOpenNote = { id in
                        if id != noteId { navPath.append(.note(id)) }
                    }
                    made.refreshNoteIds()
                    controller = made
                    if let path = ProcessInfo.processInfo.environment["FUTO_TF_STEADY_LOG"] {
                        made.steadyTyper = TextFirstSteadyTyper(controller: made, path: path)
                        made.steadyTyper?.start()
                    }
                    if autoFocus { made.textView.becomeFirstResponder() }
                    return
                } catch EditorSessionError.SessionAlreadyOpen where attempts < 20 {
                    attempts += 1
                    try? await Task.sleep(nanoseconds: 100_000_000)
                } catch {
                    // A note that cannot be opened never shows as a blank page.
                    print("text-first: open \(noteId) failed: \(error)")
                    if !navPath.isEmpty { navPath.removeLast() }
                    return
                }
            }
        }

        private func leave() {
            guard !leaving else { return }
            leaving = true
            renameTask?.cancel()
            if PuppetVerbs.shared.openNote == noteId { PuppetVerbs.shared.openNote = nil }
            guard let controller else {
                store.releaseDraftOwnership(token: ownerToken)
                return
            }
            self.controller = nil
            let untouched =
                autoFocus && noteId == originalId
                && titleField == splitId(id: originalId).title && !controller.dirty
            let token = ownerToken
            TextFirstLeaves.leave(
                id: noteId, controller: controller, store: store, discardIfEmpty: untouched
            ) { [store] in store.releaseDraftOwnership(token: token) }
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

        /// Rename to the typed title. A blank, illegal or colliding title keeps the current name
        /// and is not a failure.
        private func renameTo(_ raw: String) async {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty,
                validateTitle(title: trimmed).allSatisfy({ $0.kind == "empty" })
            else { return }
            let parts = splitId(id: noteId)
            let sanitized = sanitizeTitle(title: trimmed)
            guard sanitized != parts.title else { return }
            let target = makeId(folder: parts.folder, title: sanitized)
            let key = collisionKey(id: target)
            guard
                !store.notes.contains(where: { $0.id != noteId && collisionKey(id: $0.id) == key })
            else { return }
            switch await store.rename(
                oldId: noteId, newId: target, draft: nil, ownerToken: ownerToken)
            {
            case .committed(let committed):
                noteId = committed.id
                controller?.adoptIdentity(committed.id)
                if titleField == raw { titleField = splitId(id: committed.id).title }
                controller?.drainCoordinatedChanges()
            case .failed:
                store.showTransient(LocalizedMessage("notes.title.renameFailed"))
            }
        }
    }
#endif

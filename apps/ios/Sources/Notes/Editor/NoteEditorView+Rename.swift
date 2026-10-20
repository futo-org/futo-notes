import SwiftUI

struct RenameResolution {
    let id: String
    let isCommitted: Bool
    /// The body the relink left in the renamed note (a self-link), if it rewrote it.
    var relinkedBody: String? = nil
}

func resolvedRename(
    currentId: String,
    outcome: NoteMutationOutcome<CommittedNote>
) -> RenameResolution {
    switch outcome {
    case .committed(let committed):
        RenameResolution(
            id: committed.id, isCommitted: true, relinkedBody: committed.relinkedBody)
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

extension NoteEditorView {
    func commitRename() {
        let requestedTitle = renameField
        session.schedule(.rename) {
            await applyRename(requestedTitle)
        }
    }

    /// Debounced inline-title rename (Android parity): reschedule on each
    /// keystroke and rename once typing settles. Cancelled on leave/delete.
    func retargetNoteId(_ id: String) async {
        guard id != noteId else { return }
        let oldId = noteId
        let current = await EditorHost.shared.awaitCurrent(oldId)
        if let live = current.latest?.content, live != content { receiveEditorChange(live) }
        if !current.canProceed {
            let token = draftToken
            let base = savedContent
            EditorHost.shared.retainUnflushed(oldId) { text in
                store.flushRetainedEditor(
                    PendingDraft(id: id, base: base, content: text), ownerToken: token)
            }
        }
        EditorHost.shared.prepareLoad(id)
        EditorHost.shared.retarget(from: oldId, to: id)
        noteId = id
    }

    func scheduleRename(_ newTitle: String) {
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
    func applyRename(_ rawTitle: String) async -> Bool {
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
        let targetId = makeId(folder: parts.folder, title: sanitized)
        let resolution = resolvedRename(
            currentId: noteId,
            outcome: await store.rename(
                oldId: noteId, newId: targetId,
                draft: PendingDraft(id: noteId, base: savedContent, content: flushed),
                ownerToken: draftToken)
        )
        guard resolution.isCommitted else {
            store.showTransient(LocalizedMessage("notes.title.renameFailed"))
            return false
        }
        savedContent = flushed
        await retargetNoteId(resolution.id)
        titleField = splitId(id: resolution.id).title
        await settleRelink(flushed: flushed, relinkedBody: resolution.relinkedBody)
        return true
    }

    /// A rename or move whose relink rewrote THIS note's own links (a
    /// self-link) left a file that differs from the draft the engine saved
    /// first. The file is the baseline; the editor shows it unless the user has
    /// typed since (see ``rebasedOnRelink``). Without this the next save reads
    /// the relink as a peer's edit and parks a conflict copy (RC-71).
    func settleRelink(flushed: String, relinkedBody: String?) async {
        guard let body = relinkedBody, body != flushed else { return }
        savedContent = body
        let loadedDocument = await EditorHost.shared.awaitLoaded(noteId, content: content)
        guard loadedDocument.latest != nil else { return }
        await settleRelinkAdoption(
            flushed: flushed,
            relinkedBody: body,
            awaitCurrent: { await EditorHost.shared.awaitCurrent(noteId) },
            liveContent: { content },
            receiveChange: { receiveEditorChange($0) },
            setBaseline: { savedContent = $0 },
            apply: { replacement, generation in
                let applied = await EditorHost.shared.applyExternal(
                    noteId: noteId, content: replacement, expectedGeneration: generation)
                if applied { content = replacement }
                return applied
            }
        )
    }

    /// Inline title editing (desktop parity): update the persistent warning for
    /// the current text and (re)schedule the debounced rename. The forbidden-char
    /// transient warning is raised separately by the field's `onForbidden`.
    func handleTitleChange(_ cleaned: String) {
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
    func setTitleWarning(_ message: LocalizedMessage, transient: Bool) {
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
}

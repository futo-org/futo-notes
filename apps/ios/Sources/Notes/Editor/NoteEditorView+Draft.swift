import SwiftUI

/// The state the unsaved-draft derivation reads, bundled into one Equatable
/// value so a single `.onChange` fires on any relevant change.
struct DraftInputs: Equatable {
    let loaded: Bool
    let noteId: String
    let savedContent: String
    let content: String
}

extension NoteEditorView {
    /// The inputs the draft derivation depends on, bundled so a single
    /// `.onChange` re-publishes whenever any of them moves.
    var draftInputs: DraftInputs {
        DraftInputs(loaded: loaded, noteId: noteId, savedContent: savedContent, content: content)
    }

    /// Publish this editor's DERIVED draft into the store's register under its
    /// token (no-op before the token is claimed). The derivation returns nil the
    /// instant the body is clean (content == savedContent), so a completed save or
    /// an adopted remote clears the draft with no explicit clear call.
    func publishDraft() {
        guard draftToken != 0 else { return }
        store.publishDraft(
            token: draftToken,
            derivePendingDraft(
                loaded: loaded, noteId: noteId, savedContent: savedContent, content: content))
    }

    func scheduleSave(_ newContent: String) {
        session.schedule(.save) {
            try? await Task.sleep(nanoseconds: CloseLedger.saveDebounceNanoseconds(400_000_000))
            guard session.isActive else { return false }
            return await persistBody(newContent)
        }
    }

    func persistBody(_ newContent: String) async -> Bool {
        // Re-read identity and base at FIRE time. A sync disposition may
        // have followed a rename or rebased the draft while this debounce
        // waited; the engine's flush verb, never a raw write, resolves that
        // three-way state without clobbering the peer version.
        let savedId = noteId
        let base = savedContent
        let disposition = await store.flushDraft(
            PendingDraft(id: savedId, base: base, content: newContent), ownerToken: draftToken)
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
            await retargetNoteId(parkedId)
            titleField = splitId(id: parkedId).title
            store.showTransient(LocalizedMessage("notes.save.conflictCopy"))
        }
        return true
    }
}

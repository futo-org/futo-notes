import Testing

@testable import FutoNotesNative

/// What the editor records after a flush that already committed.
///
/// This is the rule the debounced autosave lost when it moved off
/// `store.write` + `confirmedSavedContent` (a tested pure function) onto
/// `store.flushDraft` with the decision inlined in the view: a keystroke landing
/// while the flush was in flight cancelled the save task, the write stayed on
/// disk, and the baseline advance was skipped — so the next flush's `base` was
/// behind disk and the engine parked the editor's own earlier write as a
/// conflict copy. Typing at roughly 2.5 characters per second minted nine copies
/// of one note in three minutes on a simulator.
///
/// The invariant these tests hold: a DURABLE write always advances the baseline.
/// `settledFlush` therefore takes no liveness input at all — only identity can
/// veto it — and that absence is the fix. A cancellation flag reappearing in
/// this signature is the regression.
@Suite("Settled flush")
struct SettledFlushTests {
    @Test("a write advances the baseline to the bytes that landed")
    func wroteRecords() {
        #expect(
            settledFlush(
                disposition: .wrote,
                writtenContent: "typed",
                flushedId: "note",
                currentId: "note",
                sessionIsClosing: false
            ) == .record(savedContent: "typed"))
    }

    @Test("a converged flush advances the baseline — disk already holds the draft")
    func convergedRecords() {
        #expect(
            settledFlush(
                disposition: .converged,
                writtenContent: "typed",
                flushedId: "note",
                currentId: "note",
                sessionIsClosing: false
            ) == .record(savedContent: "typed"))
    }

    @Test("a recreated note advances the baseline at its original id")
    func recreatedRecords() {
        #expect(
            settledFlush(
                disposition: .recreated,
                writtenContent: "typed",
                flushedId: "note",
                currentId: "note",
                sessionIsClosing: false
            ) == .record(savedContent: "typed"))
    }

    @Test("a parked draft is followed to the copy AND records its baseline")
    func parkedFollows() {
        #expect(
            settledFlush(
                disposition: .parkedConflict(parkedId: "note (conflict 2026-08-21)"),
                writtenContent: "typed",
                flushedId: "note",
                currentId: "note",
                sessionIsClosing: false
            ) == .follow(parkedId: "note (conflict 2026-08-21)", savedContent: "typed"))
    }

    // Without the baseline advance on the parked arm the editor would sit on the
    // copy with a base describing the ORIGINAL, and park again on the next save.
    // That is how one conflict copy became nine.
    @Test("following a park never leaves the baseline behind the copy on disk")
    func parkedFollowRecordsTheSameBytes() {
        let settled = settledFlush(
            disposition: .parkedConflict(parkedId: "note (conflict 2026-08-21)"),
            writtenContent: "typed",
            flushedId: "note",
            currentId: "note",
            sessionIsClosing: false
        )
        guard case .follow(_, let savedContent) = settled else {
            Issue.record("a park must be followed")
            return
        }
        #expect(savedContent == "typed")
    }

    @Test("a park during a destructive exit records the bytes without rebinding identity")
    func parkedWhileClosingDoesNotRebind() {
        #expect(
            settledFlush(
                disposition: .parkedConflict(parkedId: "note (conflict 2026-08-21)"),
                writtenContent: "typed",
                flushedId: "note",
                currentId: "note",
                sessionIsClosing: true
            ) == .record(savedContent: "typed"))
    }

    @Test("a failed flush leaves the baseline alone so the draft stays dirty")
    func failureIsIgnored() {
        #expect(
            settledFlush(
                disposition: nil,
                writtenContent: "typed",
                flushedId: "note",
                currentId: "note",
                sessionIsClosing: false
            ) == .ignore)
    }

    @Test("a write that landed at an id the editor has left records nothing")
    func movedIdentityIsIgnored() {
        #expect(
            settledFlush(
                disposition: .wrote,
                writtenContent: "typed",
                flushedId: "note",
                currentId: "renamed",
                sessionIsClosing: false
            ) == .ignore)
    }
}

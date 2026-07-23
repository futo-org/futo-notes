import Foundation
import Testing

@testable import FutoNotesNative

/// The open-note adopt decision `NoteEditorView.adoptExternalChange` makes after
/// the engine's flush verb resolves a dirty draft during a live pull. Pure, so
/// the persist-or-park arm choice is a table test rather than a device scenario.
@Suite("adoptFlushOutcome — live-pull dirty-draft disposition")
struct AdoptFlushOutcomeTests {
    @Test("a written draft keeps the draft in the editor")
    func wroteKeepsDraft() {
        #expect(adoptFlushOutcome(for: .wrote) == .keepDraft)
    }

    @Test("a recreated draft keeps the draft in the editor")
    func recreatedKeepsDraft() {
        #expect(adoptFlushOutcome(for: .recreated) == .keepDraft)
    }

    // Regression (issue #37 F3): the converged race — an in-flight unconditional
    // autosave lands the draft on disk just before flush_draft, so the engine
    // sees disk == content and returns .converged. The draft IS the on-disk
    // content; the arm must keep it, NOT adopt the stale pre-flush disk snapshot
    // clean (which would let the next keystroke's autosave destroy the
    // just-persisted draft with no conflict copy). Converged must group with
    // wrote/recreated, never with parkedConflict.
    @Test("a converged draft keeps the draft in the editor — not adopt-disk")
    func convergedKeepsDraftNotAdopt() {
        #expect(adoptFlushOutcome(for: .converged) == .keepDraft)
        #expect(adoptFlushOutcome(for: .converged) != .reloadDisk)
    }

    @Test("a parked draft requires a fresh read of the on-disk peer version")
    func parkedReloadsDisk() {
        #expect(adoptFlushOutcome(for: .parkedConflict(parkedId: "note (conflict 2026-07-21)")) == .reloadDisk)
    }

    @Test("a failed flush leaves the draft dirty to retry")
    func failedFlushRetriesLater() {
        #expect(adoptFlushOutcome(for: nil) == .retryLater)
    }
}

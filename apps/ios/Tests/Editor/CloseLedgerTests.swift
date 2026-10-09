import Foundation
import Testing

@testable import FutoNotesNative

/// The close bench's hooks (`CloseLedger.swift`) live in the Debug app, so an
/// ordinary debug run must not pick them up: they hold the editor's body save
/// for an hour and add a window-wide touch recognizer. Both are keyed on
/// `FUTO_CLOSE_PERF=1`, which only the bench's UI test sets.
@Suite("Close ledger bench hooks")
struct CloseLedgerTests {
    @Test("without the bench variable the editor keeps its shipped save debounce")
    func saveDebounceIsUntouchedOutsideTheBench() {
        #expect(ProcessInfo.processInfo.environment["FUTO_CLOSE_PERF"] == nil)
        #expect(CloseLedger.saveDebounceNanoseconds(400_000_000) == 400_000_000)
    }
}

import Foundation
import Testing

@testable import FutoNotesNative

@Suite("NoteVault search-readiness wait")
struct SearchReadinessWaitTests {
  @Test("concurrent readiness waits do not starve the cooperative pool")
  func waitsDoNotStarveCooperativePool() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("readiness-wait-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    // Without bootstrap, every readiness wait consumes its full budget.
    let vault = NoteVault(notesRoot: root.path)
    let waitBudgetMs: UInt64 = 2_000
    let concurrentWaits = 32

    let clock = ContinuousClock()
    let start = clock.now
    let waits = (0..<concurrentWaits).map { _ in
      Task { await vault.waitUntilSearchReady(timeoutMs: waitBudgetMs) }
    }
    try await Task.sleep(for: .milliseconds(100))
    _ = await vault.exists("probe")
    let probeElapsed = clock.now - start

    for wait in waits { _ = await wait.value }
    #expect(
      probeElapsed < .seconds(1),
      "vault actor work stalled \(probeElapsed) behind \(concurrentWaits) readiness waits — the blocking engine wait is occupying the cooperative pool"
    )
  }
}

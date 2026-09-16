import Foundation
import Testing

@testable import FutoNotesNative

/// Anchors `Bundle(for:)` to the test bundle so we can load its resources
/// (Swift Testing suites are structs, and `Bundle(for:)` needs a class).
private final class SessionModeBundleToken {}

// Not `private`: these appear in `@Test` signatures / `arguments:`, which the
// Testing macro generates internal-level references to.
struct HostedConnectEntryCase: Decodable {
    let name: String
    let connected: Bool
    let hasClient: Bool
    let healing: Bool
    let mode: String?
    let expected: String
}

struct RestoreBranchCase: Decodable {
    let name: String
    let hasStoredPassword: Bool
    let hasHostedVault: Bool
    let expected: String
}

private struct SessionModeOp<Case: Decodable>: Decodable {
    let cases: [Case]
}

private struct SessionModeOps: Decodable {
    let hostedConnectEntry: SessionModeOp<HostedConnectEntryCase>
    let restoreBranch: SessionModeOp<RestoreBranchCase>
}

private struct SessionModeFixture: Decodable {
    let ops: SessionModeOps
}

/// The shared cross-shell case-set (`tests/conformance/sync-session-mode.json`)
/// is bundled as a resource — not duplicated. An empty result (missing or
/// unreadable resource) makes `fixtureIsPresent` fail rather than letting every
/// parameterised test pass vacuously on zero cases.
private func loadFixture() -> SessionModeFixture? {
    let bundle = Bundle(for: SessionModeBundleToken.self)
    guard let url = bundle.url(forResource: "sync-session-mode", withExtension: "json"),
        let data = try? Data(contentsOf: url)
    else { return nil }
    return try? JSONDecoder().decode(SessionModeFixture.self, from: data)
}

private let fixture = loadFixture()
private let hostedConnectEntryCases = fixture?.ops.hostedConnectEntry.cases ?? []
private let restoreBranchCases = fixture?.ops.restoreBranch.cases ?? []

/// Locks Swift's two session-precedence decisions to the shared fixture the
/// Kotlin copies are checked against. Both shells must answer these the same
/// way or a device behaves differently on iOS and Android for the same saved
/// secrets, which is exactly what `docs/spec/sync.md` specifies once.
@MainActor
@Suite("Sync session mode conformance")
struct SyncSessionModeConformanceTests {
    @Test("shared sync-session-mode fixture is bundled and complete")
    func fixtureIsPresent() {
        #expect(hostedConnectEntryCases.count == 8)
        #expect(restoreBranchCases.count == 4)
    }

    @Test("hostedConnectEntry matches the shared fixture", arguments: hostedConnectEntryCases)
    func hostedConnectEntryConforms(testCase: HostedConnectEntryCase) {
        let mode: SyncManager.SessionMode? =
            switch testCase.mode {
            case "hosted": .hosted
            case "selfHosted": .selfHosted
            default: nil
            }
        let entry = SyncManager.hostedConnectEntry(
            connected: testCase.connected,
            hasClient: testCase.hasClient,
            healing: testCase.healing,
            mode: mode
        )
        #expect(entry.fixtureName == testCase.expected, "\(testCase.name)")
    }

    @Test("restoreBranch matches the shared fixture", arguments: restoreBranchCases)
    func restoreBranchConforms(testCase: RestoreBranchCase) {
        let branch = SyncManager.restoreBranch(
            hasStoredPassword: testCase.hasStoredPassword,
            hasHostedVault: testCase.hasHostedVault
        )
        #expect(branch.fixtureName == testCase.expected, "\(testCase.name)")
    }
}

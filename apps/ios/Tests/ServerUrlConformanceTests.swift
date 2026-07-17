import Foundation
import Testing

@testable import FutoNotesNative

/// Anchors `Bundle(for:)` to the test bundle so we can load its resources
/// (Swift Testing suites are structs, and `Bundle(for:)` needs a class).
private final class BundleToken {}

// Not `private`: these appear in the `@Test` method signature / `arguments:`,
// which the Testing macro generates internal-level references to.
struct ServerUrlCase: Decodable {
  let input: String
  let expected: String?
}

struct ServerUrlFixture: Decodable {
  let cases: [ServerUrlCase]
}

/// The shared cross-shell case-set (`tests/conformance/server-url.json`) is
/// bundled as a resource — not duplicated. An empty result (missing/unreadable
/// resource) makes `fixtureIsPresent` fail rather than pass vacuously.
private func loadServerUrlCases() -> [ServerUrlCase] {
  let bundle = Bundle(for: BundleToken.self)
  guard let url = bundle.url(forResource: "server-url", withExtension: "json"),
    let data = try? Data(contentsOf: url),
    let fixture = try? JSONDecoder().decode(ServerUrlFixture.self, from: data)
  else { return [] }
  return fixture.cases
}

private let serverUrlCases = loadServerUrlCases()

/// Locks Swift's `SyncManager.validateServerURL` to the shared fixture that the
/// TS and Kotlin copies are already checked against — the AGENTS.md §12
/// drift-watchlist hole ("the Swift copy has no automated fixture check").
///
/// `@MainActor` because `SyncManager` is `@MainActor`, so its static
/// `validateServerURL` is main-actor-isolated.
@MainActor
@Suite("validateServerURL conformance")
struct ServerUrlConformanceTests {
  @Test("shared server-url fixture is bundled and complete")
  func fixtureIsPresent() {
    #expect(serverUrlCases.count >= 9)
  }

  @Test("Swift validateServerURL matches every shared fixture case", arguments: serverUrlCases)
  func matchesFixture(_ testCase: ServerUrlCase) {
    #expect(
      SyncManager.validateServerURL(testCase.input) == testCase.expected,
      "input \(testCase.input.debugDescription)")
  }
}

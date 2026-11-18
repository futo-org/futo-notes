import Foundation
import StoreKitTest
import Testing

/// Opens StoreKit's local test environment once and nothing more: the warm-up
/// process a freshly erased iOS 27 simulator needs before the StoreKit suites can
/// find a product (the first process to create an `SKTestSession` there finds
/// none; every later one does). Only the Xcode 27 canary (ci/cirrus/
/// ios-test-xcode27.yml) runs it, alone and ahead of the real run, with
/// `TEST_RUNNER_FUTO_STOREKIT_PRIME=1`; everywhere else it skips, so no other
/// run's StoreKit state changes.
@MainActor
@Suite(
    "StoreKit test environment",
    .enabled(
        "only the warm-up step opts in",
        { ProcessInfo.processInfo.environment["FUTO_STOREKIT_PRIME"] == "1" }))
struct StoreKitPrimeTests {
    @Test("a session opens on this simulator")
    func sessionOpens() throws {
        let session = try SKTestSession(configurationFileNamed: "FutoNotes")
        session.resetToDefaultState()
    }
}
